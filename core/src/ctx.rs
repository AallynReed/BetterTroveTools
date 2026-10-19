//! Process-wide backend state and the [`Host`] the shell provides.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::{json, Value};

/// A file-type filter for a dialog, e.g. `FileFilter::new("Trove Mods", &["tmod"])`.
#[derive(Debug, Clone)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

impl FileFilter {
    pub fn new(name: &str, extensions: &[&str]) -> Self {
        FileFilter { name: name.to_string(), extensions: extensions.iter().map(|e| e.to_string()).collect() }
    }
}

/// What tkinter's `filedialog.ask*` took.
#[derive(Debug, Clone, Default)]
pub struct Dialog {
    pub title: String,
    pub initial_dir: Option<PathBuf>,
    pub default_name: Option<String>,
    pub filters: Vec<FileFilter>,
}

impl Dialog {
    pub fn new(title: &str) -> Self {
        Dialog { title: title.to_string(), ..Default::default() }
    }

    pub fn initial_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        if !dir.as_os_str().is_empty() {
            self.initial_dir = Some(dir);
        }
        self
    }

    pub fn default_name(mut self, name: &str) -> Self {
        self.default_name = Some(name.to_string());
        self
    }

    pub fn filter(mut self, name: &str, extensions: &[&str]) -> Self {
        self.filters.push(FileFilter::new(name, extensions));
        self
    }
}

/// Everything the backend needs from the window it runs behind.
pub trait Host: Send + Sync + 'static {
    /// Calls a page function registered with `eel.expose(fn, name)`. Fire and forget.
    /// When `keep` is set, the page remembers the return value under that id, and any
    /// later argument of the form `{"$rid": id}` is replaced by it.
    fn call_js(&self, name: &str, args: Vec<Value>, keep: Option<&str>);

    /// True once the page has loaded and can receive [`Host::call_js`].
    fn page_ready(&self) -> bool;

    fn pick_folder(&self, dialog: Dialog) -> Option<PathBuf>;
    fn pick_file(&self, dialog: Dialog) -> Option<PathBuf>;
    fn pick_files(&self, dialog: Dialog) -> Vec<PathBuf>;
    fn save_file(&self, dialog: Dialog) -> Option<PathBuf>;

    /// Shows a desktop notification. False when it could not be shown.
    fn notify(&self, title: &str, body: &str) -> bool;

    /// Whether [`Host::notify`] can deliver anything here.
    fn notifications_available(&self) -> bool;

    /// The reminder scheduler is on or off: keep the tray icon visible while it is on.
    fn set_reminders_active(&self, active: bool);

    /// Quits the app after `delay_secs` (the self-updater's hand-off).
    fn exit_after(&self, delay_secs: f64);
}

pub struct Ctx {
    host: Box<dyn Host>,
    /// Holds `web/`, `data/`, `LICENSE` and `metadata.json` (the repo root in dev).
    pub resource_dir: PathBuf,
    /// Running from source rather than the packaged build (Python's `not sys.frozen`).
    pub dev_mode: bool,
    /// The `btt://` link the app was launched with.
    pub startup_url: Mutex<Option<String>>,
    next_rid: AtomicU64,
}

static CTX: OnceLock<Arc<Ctx>> = OnceLock::new();

/// Installs the process-wide context. Later calls are ignored.
pub fn init(host: Box<dyn Host>, resource_dir: PathBuf, dev_mode: bool, startup_url: Option<String>) -> Arc<Ctx> {
    CTX.get_or_init(|| {
        Arc::new(Ctx {
            host,
            resource_dir,
            dev_mode,
            startup_url: Mutex::new(startup_url),
            next_rid: AtomicU64::new(1),
        })
    })
    .clone()
}

/// The process-wide context. Panics before [`init`]; tests use [`testing::init`].
pub fn ctx() -> &'static Ctx {
    CTX.get().expect("btt_core::init was not called")
}

/// The context when one is installed.
pub fn try_ctx() -> Option<&'static Ctx> {
    CTX.get().map(|c| c.as_ref())
}

impl Ctx {
    pub fn host(&self) -> &dyn Host {
        self.host.as_ref()
    }

    /// `eel.<name>(*args)()` from Python.
    pub fn js(&self, name: &str, args: Vec<Value>) {
        self.host.call_js(name, args, None);
    }

    pub fn resource(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.resource_dir.join(rel)
    }

    /// A file under `web/`, e.g. `web_path("assets/data/biomes.json")`.
    pub fn web_path(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.resource_dir.join("web").join(rel)
    }

    /// Logs an outbound request in the page's network panel until the guard finishes.
    /// `eel.add_external_request(label, url)()` / `eel.remove_external_request(id, ok)()`.
    pub fn external_request(&self, label: &str, url: &str) -> ExternalRequest {
        let rid = format!("r{}", self.next_rid.fetch_add(1, Ordering::Relaxed));
        self.host.call_js("add_external_request", vec![json!(label), json!(url)], Some(&rid));
        ExternalRequest { rid, finished: false }
    }

    /// Blocks until the page is attached or `timeout` passes. Python polled `eel._websockets`.
    pub fn wait_for_page(&self, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while !self.host.page_ready() {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        true
    }
}

/// See [`Ctx::external_request`]. Dropping it unfinished marks the request failed.
pub struct ExternalRequest {
    rid: String,
    finished: bool,
}

impl ExternalRequest {
    pub fn finish(mut self, success: bool) {
        self.send(success);
    }

    fn send(&mut self, success: bool) {
        if self.finished {
            return;
        }
        self.finished = true;
        if let Some(c) = CTX.get() {
            c.host.call_js("remove_external_request", vec![json!({ "$rid": self.rid }), json!(success)], None);
        }
    }
}

impl Drop for ExternalRequest {
    fn drop(&mut self) {
        self.send(false);
    }
}

/// A recording host for unit tests.
pub mod testing {
    use super::*;

    #[derive(Default)]
    pub struct TestHost {
        pub calls: Mutex<Vec<(String, Vec<Value>)>>,
    }

    impl Host for Arc<TestHost> {
        fn call_js(&self, name: &str, args: Vec<Value>, _keep: Option<&str>) {
            self.calls.lock().push((name.to_string(), args));
        }
        fn page_ready(&self) -> bool {
            true
        }
        fn pick_folder(&self, _: Dialog) -> Option<PathBuf> {
            None
        }
        fn pick_file(&self, _: Dialog) -> Option<PathBuf> {
            None
        }
        fn pick_files(&self, _: Dialog) -> Vec<PathBuf> {
            Vec::new()
        }
        fn save_file(&self, _: Dialog) -> Option<PathBuf> {
            None
        }
        fn notify(&self, _: &str, _: &str) -> bool {
            true
        }
        fn notifications_available(&self) -> bool {
            true
        }
        fn set_reminders_active(&self, _: bool) {}
        fn exit_after(&self, _: f64) {}
    }

    static HOST: OnceLock<Arc<TestHost>> = OnceLock::new();

    /// Held by tests that repoint APPDATA mid-run, so they don't swap each other's folder.
    pub static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Points every data folder at a throwaway directory, once, so no test touches the
    /// user's real app data.
    pub fn sandbox() -> &'static Path {
        static DIR: OnceLock<PathBuf> = OnceLock::new();
        DIR.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("btt-core-tests-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            for key in ["APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] {
                std::env::set_var(key, &dir);
            }
            std::env::remove_var(crate::paths::DATA_DIR_ENV_VAR);
            dir
        })
    }

    /// Initializes the context once for the test binary, with the repo root as the
    /// resource dir. Returns the recording host.
    pub fn init() -> Arc<TestHost> {
        sandbox();
        let host = HOST.get_or_init(|| Arc::new(TestHost::default())).clone();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        super::init(Box::new(host.clone()), root, true, None);
        host
    }
}
