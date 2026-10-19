//! Better Trove Tools backend.
//!
//! Every function the frontend calls as `eel.<name>(...)()` is a [`Cmd`] registered in
//! [`commands`]. The Tauri shell forwards those calls to [`call`], and everything the
//! backend needs from the window (pushing to the page, file dialogs, tray balloons) goes
//! through the [`Host`] it installs with [`init`].

pub mod app;
pub mod args;
pub mod ctx;
pub mod game;
pub mod http;
pub mod json;
pub mod notify;
pub mod paths;
pub mod py;
pub mod response;
pub mod routes;
pub mod settings;
pub mod storage;

#[cfg(feature = "auth")]
pub mod auth;
#[cfg(feature = "blueprint")]
pub mod blueprint;
#[cfg(feature = "codexes")]
pub mod codexes;
#[cfg(feature = "file_manager")]
pub mod file_manager;
#[cfg(feature = "gems")]
pub mod gems;
#[cfg(feature = "home")]
pub mod home;
#[cfg(feature = "mod_manager")]
pub mod mod_manager;
#[cfg(feature = "modder_tools")]
pub mod modder_tools;
#[cfg(feature = "modfile")]
pub mod modfile;

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

pub use args::Args;
pub use ctx::{ctx, init, Ctx, Dialog, FileFilter, Host};
pub use response::Resp;

/// Mirrors `KIWI_API_BASE` in backend/home.py.
pub const KIWI_API_BASE: &str = "https://api.aallyn.net/v1";

/// Mirrors backend/feature_flags.py and `window.BTT_ENABLE_MODS_HUB`.
pub const MODS_HUB_ENABLED: bool = true;

pub type Handler = fn(&Args) -> anyhow::Result<Value>;

/// One eel endpoint. `standardize` applies backend/response.py's `@standardize_response`.
pub struct Cmd {
    pub name: &'static str,
    pub handler: Handler,
    pub standardize: bool,
}

impl Cmd {
    /// A plain `@eel.expose` function: errors reject the page's promise.
    pub const fn raw(name: &'static str, handler: Handler) -> Self {
        Cmd { name, handler, standardize: false }
    }

    /// `@eel.expose` + `@standardize_response`: errors come back as a failed envelope.
    pub const fn std(name: &'static str, handler: Handler) -> Self {
        Cmd { name, handler, standardize: true }
    }
}

/// Every registered endpoint, in no particular order.
pub fn commands() -> Vec<Cmd> {
    let mut all = Vec::new();
    all.extend(app::commands());
    all.extend(settings::commands());
    all.extend(notify::commands());
    #[cfg(feature = "home")]
    all.extend(home::commands());
    #[cfg(feature = "gems")]
    all.extend(gems::commands());
    #[cfg(feature = "codexes")]
    all.extend(codexes::commands());
    #[cfg(feature = "modder_tools")]
    all.extend(modder_tools::commands());
    #[cfg(feature = "file_manager")]
    all.extend(file_manager::commands());
    #[cfg(feature = "mod_manager")]
    all.extend(mod_manager::commands());
    #[cfg(feature = "blueprint")]
    all.extend(blueprint::commands());
    #[cfg(feature = "auth")]
    all.extend(auth::commands());
    all
}

/// main.py's launch work, all best effort on background threads.
pub fn start_background_tasks() {
    std::thread::Builder::new().name("update-sweep".into()).spawn(app::sweep_stale_update_cache).ok();
    #[cfg(feature = "auth")]
    std::thread::Builder::new().name("launcher-purge".into()).spawn(auth::purge_legacy_launcher_secrets).ok();
    #[cfg(feature = "codexes")]
    std::thread::Builder::new().name("codex-warmup".into()).spawn(codexes::warm_caches).ok();
    #[cfg(feature = "mod_manager")]
    {
        std::thread::Builder::new().name("mods-probe".into()).spawn(mod_manager::probe_mods_on_launch).ok();
        std::thread::Builder::new().name("mods-auto-update".into()).spawn(mod_manager::auto_update_mods_on_launch).ok();
        std::thread::Builder::new().name("mods-takedown".into()).spawn(mod_manager::remove_taken_down_mods_task).ok();
    }
    #[cfg(feature = "home")]
    home::start_live_feed();
}

fn registry() -> &'static HashMap<&'static str, Cmd> {
    static REGISTRY: OnceLock<HashMap<&'static str, Cmd>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut map = HashMap::new();
        for cmd in commands() {
            if map.insert(cmd.name, cmd).is_some() {
                panic!("duplicate eel endpoint registered");
            }
        }
        map
    })
}

/// Names of every endpoint, for the page's `eel` object.
pub fn command_names() -> Vec<&'static str> {
    let mut names: Vec<_> = registry().keys().copied().collect();
    names.sort_unstable();
    names
}

/// Runs one endpoint. `None` when no endpoint has that name.
pub fn call(name: &str, args: Vec<Value>) -> Option<Result<Value, String>> {
    let cmd = registry().get(name)?;
    let args = Args::new(args);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (cmd.handler)(&args)));
    let result = match outcome {
        Ok(result) => result,
        Err(panic) => Err(anyhow::anyhow!(panic_message(&panic))),
    };
    Some(if cmd.standardize {
        Ok(match result {
            Ok(value) => response::normalize(value),
            Err(err) => Resp::fail(err.to_string(), "UNHANDLED_EXCEPTION").into(),
        })
    } else {
        result.map_err(|err| err.to_string())
    })
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "internal error".to_string()
    }
}
