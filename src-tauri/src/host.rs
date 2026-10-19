//! The window side of `btt_core::Host`: page calls, dialogs, notifications, the tray.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use btt_core::{Dialog, Host};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_notification::NotificationExt;

/// Event the bridge listens on for backend → page calls.
const JS_CALL_EVENT: &str = "btt:js-call";

pub struct Shell {
    app: AppHandle,
    page_ready: AtomicBool,
    quitting: AtomicBool,
    tray: Mutex<Option<TrayIcon>>,
    /// The icon is shown while the window is collapsed into it, or while reminders are on.
    collapsed: AtomicBool,
    reminders: AtomicBool,
}

impl Shell {
    pub fn new(app: AppHandle) -> Self {
        Shell {
            app,
            page_ready: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            tray: Mutex::new(None),
            collapsed: AtomicBool::new(false),
            reminders: AtomicBool::new(btt_core::app::notifications_enabled()),
        }
    }

    pub fn set_page_ready(&self) {
        self.page_ready.store(true, Ordering::SeqCst);
    }

    pub fn create_tray(self: &Arc<Self>, title: &str) -> tauri::Result<()> {
        let open = MenuItem::with_id(&self.app, "open", "Open", true, None::<&str>)?;
        let quit = MenuItem::with_id(&self.app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(&self.app, &[&open, &quit])?;
        let mut builder = TrayIconBuilder::with_id("main").tooltip(title).menu(&menu).show_menu_on_left_click(false);
        if let Some(icon) = self.app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        let menu_shell = self.clone();
        let click_shell = self.clone();
        let tray = builder
            .on_menu_event(move |_app, event| match event.id().as_ref() {
                "open" => menu_shell.restore_window(),
                "quit" => menu_shell.quit(),
                _ => {}
            })
            .on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    click_shell.restore_window();
                }
            })
            .build(&self.app)?;
        *self.tray.lock() = Some(tray);
        self.apply_tray_visibility();
        Ok(())
    }

    fn apply_tray_visibility(&self) {
        let visible = self.collapsed.load(Ordering::SeqCst) || self.reminders.load(Ordering::SeqCst);
        if let Some(tray) = &*self.tray.lock() {
            let _ = tray.set_visible(visible);
        }
    }

    /// Close-to-tray is on (default) and this is not a real quit.
    pub fn should_hide_on_close(&self) -> bool {
        !self.quitting.load(Ordering::SeqCst) && self.tray.lock().is_some() && btt_core::app::close_to_tray_enabled()
    }

    pub fn collapse_to_tray(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.hide();
        }
        self.collapsed.store(true, Ordering::SeqCst);
        self.apply_tray_visibility();
        // A freshly shown tray icon drops notifications fired before the shell registers it.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(1200));
            let name = btt_core::app::app_name();
            btt_core::notify::notify_once(
                "close_to_tray_first_time",
                &name,
                &format!("{} is still running in the system tray. Right-click the tray icon to quit.", name),
            );
        });
    }

    pub fn restore_window(&self) {
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        self.collapsed.store(false, Ordering::SeqCst);
        self.apply_tray_visibility();
    }

    pub fn quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        if let Some(tray) = self.tray.lock().take() {
            let _ = tray.set_visible(false);
        }
        self.app.exit(0);
    }

    fn file_dialog(&self, d: Dialog) -> FileDialogBuilder<tauri::Wry> {
        let mut b = self.app.dialog().file().set_title(&d.title);
        if let Some(dir) = d.initial_dir {
            b = b.set_directory(dir);
        }
        if let Some(name) = d.default_name {
            b = b.set_file_name(name);
        }
        for f in &d.filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            b = b.add_filter(&f.name, &exts);
        }
        if let Some(w) = self.app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        b
    }
}

/// `btt_core::Host` for the shell.
pub struct TauriHost(pub Arc<Shell>);

fn to_path(p: tauri_plugin_dialog::FilePath) -> Option<PathBuf> {
    p.into_path().ok()
}

impl Host for TauriHost {
    fn call_js(&self, name: &str, args: Vec<Value>, keep: Option<&str>) {
        let payload = json!({ "name": name, "args": args, "keep": keep });
        let _ = self.0.app.emit_to("main", JS_CALL_EVENT, payload);
    }

    fn page_ready(&self) -> bool {
        self.0.page_ready.load(Ordering::SeqCst)
    }

    fn pick_folder(&self, dialog: Dialog) -> Option<PathBuf> {
        self.0.file_dialog(dialog).blocking_pick_folder().and_then(to_path)
    }

    fn pick_file(&self, dialog: Dialog) -> Option<PathBuf> {
        self.0.file_dialog(dialog).blocking_pick_file().and_then(to_path)
    }

    fn pick_files(&self, dialog: Dialog) -> Vec<PathBuf> {
        self.0.file_dialog(dialog).blocking_pick_files().unwrap_or_default().into_iter().filter_map(to_path).collect()
    }

    fn save_file(&self, dialog: Dialog) -> Option<PathBuf> {
        self.0.file_dialog(dialog).blocking_save_file().and_then(to_path)
    }

    fn notify(&self, title: &str, body: &str) -> bool {
        self.0.app.notification().builder().title(title).body(body).show().is_ok()
    }

    fn notifications_available(&self) -> bool {
        true
    }

    fn set_reminders_active(&self, active: bool) {
        self.0.reminders.store(active, Ordering::SeqCst);
        self.0.apply_tray_visibility();
    }

    fn exit_after(&self, delay_secs: f64) {
        let shell = self.0.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs_f64(delay_secs));
            shell.quit();
        });
    }
}
