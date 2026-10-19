//! The native shell: one window, a tray icon, single-instance hand-off, and the bridge
//! that carries the page's `eel.<name>(...)()` calls to `btt_core`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;
mod platform;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::http::{header, Response as HttpResponse};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use host::{Shell, TauriHost};

/// The scheme `/api/...` and `/proxy/...` are served on (see web/js/tauri_bridge.js).
const BACKEND_SCHEME: &str = "bttapi";

#[tauri::command]
async fn eel_call(name: String, args: Vec<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || match btt_core::call(&name, args) {
        Some(result) => result,
        None => Err(format!("No backend function named '{}'", name)),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn eel_ready(shell: tauri::State<'_, Arc<Shell>>) {
    shell.set_page_ready();
}

fn resource_dir(app: &tauri::AppHandle) -> (PathBuf, bool) {
    if cfg!(debug_assertions) {
        return (PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf(), true);
    }
    let dir = app.path().resource_dir().unwrap_or_else(|_| std::env::current_exe().unwrap().parent().unwrap().to_path_buf());
    (dir, std::env::var("BTT_DEV").as_deref() == Ok("1"))
}

fn startup_url() -> Option<String> {
    std::env::args().find(|a| a.starts_with("btt://"))
}

fn init_script() -> String {
    let names: Vec<&str> = btt_core::command_names();
    format!(
        "window.__BTT_COMMANDS__ = {};\nwindow.__BTT_BACKEND_SCHEME__ = {};",
        serde_json::to_string(&names).unwrap(),
        serde_json::to_string(BACKEND_SCHEME).unwrap()
    )
}

fn serve_backend(request: tauri::http::Request<Vec<u8>>) -> HttpResponse<Vec<u8>> {
    let uri = request.uri();
    let req = btt_core::routes::Request {
        method: request.method().as_str().to_string(),
        path: uri.path().to_string(),
        query: uri.query().unwrap_or("").to_string(),
        headers: request
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
            .collect(),
        body: request.body().clone(),
    };
    let resp = btt_core::routes::handle(&req);
    let mut builder = HttpResponse::builder()
        .status(resp.status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "*");
    for (k, v) in &resp.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    builder.body(resp.body).unwrap_or_else(|_| HttpResponse::new(Vec::new()))
}

fn main() {
    #[cfg(windows)]
    if !platform::webview2_installed() {
        platform::webview2_missing_dialog();
        std::process::exit(1);
    }
    // A dev build must not take btt:// links away from the installed app.
    if !cfg!(debug_assertions) {
        platform::register_btt_protocol();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let (Some(url), Some(ctx)) = (argv.iter().find(|a| a.starts_with("btt://")), btt_core::ctx::try_ctx()) {
                ctx.js("handle_deep_link", vec![Value::String(url.clone())]);
            }
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                shell.restore_window();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol(BACKEND_SCHEME, |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(serve_backend(request)));
        })
        .invoke_handler(tauri::generate_handler![eel_call, eel_ready])
        .setup(|app| {
            let handle = app.handle().clone();
            let shell = Arc::new(Shell::new(handle.clone()));
            app.manage(shell.clone());

            // The .deb carries the btt:// MimeType itself; AppImage, Nix and source runs register at launch.
            #[cfg(target_os = "linux")]
            if !cfg!(debug_assertions) {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("Failed to register btt:// links: {}", e);
                }
            }

            let (resources, dev_mode) = resource_dir(&handle);
            btt_core::init(Box::new(TauriHost(shell.clone())), resources, dev_mode, startup_url());

            let title = btt_core::app::app_name();
            let data_dir = btt_core::paths::get_app_data_dir().join("WebView2");
            let _ = std::fs::create_dir_all(&data_dir);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&title)
                .inner_size(1700.0, 1000.0)
                .min_inner_size(1100.0, 700.0)
                .data_directory(data_dir)
                .initialization_script(&init_script())
                .devtools(dev_mode || std::env::var("BTT_DEBUG").as_deref() == Ok("1"))
                .build()?;

            shell.create_tray(&title)?;

            let close_shell = shell.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if close_shell.should_hide_on_close() {
                        api.prevent_close();
                        close_shell.collapse_to_tray();
                    }
                }
            });

            btt_core::start_background_tasks();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Better Trove Tools")
        .run(|_app, _event| {});
}
