//! mod_watcher.py: the launch-time config probe and a polling watch over the mods
//! folder (and Trove.cfg's DisabledMods). A change must survive one extra 2s tick
//! before it counts, so a mod still being copied in isn't parsed half-written.

use std::collections::BTreeSet;
use std::time::Duration;

use anyhow::Result;
use parking_lot::{Condvar, Mutex};
use serde_json::{json, Value};

use super::manager::{mods_signature, Signature};
use super::or_str;
use crate::game::registry::TroveGamePath;
use crate::game::trove_cfg::{ensure_mods_enabled, read_disabled_mods};
use crate::py;
use crate::modfile::{ListOptions, TroveModList};
use crate::{Args, Resp};

const POLL: Duration = Duration::from_secs(2);

type Snapshot = (Signature, BTreeSet<String>);

fn snapshot(game: &str) -> Snapshot {
    (mods_signature(game), read_disabled_mods(None).into_iter().collect())
}

/// Reconciles every installed mod's .cfg for `game` and undoes the game's
/// `DisableAllMods`. The mods whose config could not be written. Never fails.
pub(super) fn probe_configs(game: &str) -> Vec<String> {
    let path = py::strip(game);
    if path.is_empty() {
        return Vec::new();
    }
    ensure_mods_enabled(None);
    let opts = ListOptions { partial: true, fix_configs: true, ..Default::default() };
    TroveModList::new(TroveGamePath::new(py::py_path(path), None), opts).map(|l| l.read_only_configs).unwrap_or_default()
}

#[derive(Default)]
struct State {
    target: Option<String>,
    signature: Option<Snapshot>,
    pending: Option<Snapshot>,
    running: bool,
    wake: bool,
}

static STATE: Mutex<State> = Mutex::new(State { target: None, signature: None, pending: None, running: false, wake: false });
static WAKE: Condvar = Condvar::new();

/// Points the watch at an install (or nothing). Re-baselines, so switching installs
/// never fires a spurious change.
pub(super) fn set_target(game: &str) {
    let path = Some(py::strip(game).to_string()).filter(|p| !p.is_empty());
    let start = {
        let mut s = STATE.lock();
        if path == s.target {
            return;
        }
        s.signature = path.as_deref().map(snapshot);
        s.target = path.clone();
        s.pending = None;
        s.wake = true;
        WAKE.notify_all();
        let start = path.is_some() && !s.running;
        if start {
            s.running = true;
        }
        start
    };
    if start && !super::INLINE_TASKS.load(std::sync::atomic::Ordering::SeqCst) {
        let spawned = std::thread::Builder::new().name("mods-watch".into()).spawn(run);
        if spawned.is_err() {
            STATE.lock().running = false;
        }
    }
}

fn run() {
    loop {
        {
            let mut s = STATE.lock();
            if !s.wake {
                WAKE.wait_for(&mut s, POLL);
            }
            s.wake = false;
        }
        let _ = std::panic::catch_unwind(tick);
    }
}

/// One comparison pass. The install path when a settled change was announced.
fn tick() -> Option<String> {
    let (target, settled, pending) = {
        let s = STATE.lock();
        (s.target.clone()?, s.signature.clone(), s.pending.clone())
    };
    let current = snapshot(&target);
    if Some(&current) == settled.as_ref() {
        if pending.is_some() {
            STATE.lock().pending = None;
        }
        return None;
    }
    if Some(&current) != pending.as_ref() {
        // First sighting: give it a tick to stop moving.
        let mut s = STATE.lock();
        if s.target.as_ref() == Some(&target) {
            s.pending = Some(current);
        }
        return None;
    }
    {
        let mut s = STATE.lock();
        if s.target.as_ref() != Some(&target) {
            return None;
        }
        s.signature = Some(current);
        s.pending = None;
    }
    probe_configs(&target);
    if let Some(c) = crate::ctx::try_ctx() {
        c.js("receive_mods_changed", vec![json!(target)]);
    }
    Some(target)
}

/// Points the mods-folder watch at the install the user has selected.
pub(super) fn set_watched_install(a: &Args) -> Result<Value> {
    let game = or_str(a.get(0));
    set_target(&game);
    let watching = if game.is_empty() { Value::Null } else { json!(game) };
    Ok(Resp::ok(json!({ "watching": watching })).into())
}

#[cfg(test)]
pub(super) fn tick_now() -> Option<String> {
    tick()
}
