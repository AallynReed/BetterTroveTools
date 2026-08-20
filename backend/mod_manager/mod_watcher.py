"""Launch-time config probe and a live watch over the mods folder.

Two jobs, one module:

  * ``probe_configs`` re-runs the same .cfg reconciliation the Mod Manager does
    when its list loads (embedded mod config -> ``%AppData%/ModCfgs/<mod>.cfg``).
    Running it at launch means a mod dropped in while the app was closed gets a
    usable config without the user ever opening the Mod Manager tab.
  * ``ModWatcher`` polls ``<install>/mods`` and, when it settles on a change,
    re-probes and pushes ``receive_mods_changed`` to the UI so the list reloads
    itself.

Polling (name/size/mtime per file -- what ``mods_signature`` already computes for
the update cache) rather than a native watcher: mods folders hold tens of files,
the tick is 2s, and the same code path covers Windows, Linux and Android with no
new dependency. A change has to survive one extra tick before it counts, so a
mod still being copied in isn't parsed half-written.
"""

import threading
from pathlib import Path

import eel

from backend.mod_manager.mod_manager import mods_signature
from backend.response import resp, standardize_response
from models.trove.mod import TroveGamePath, TroveModList
from utils.trove_cfg import ensure_mods_enabled

POLL_SECONDS = 2.0


def probe_configs(game_path):
    """Reconcile every installed mod's .cfg for `game_path`, and undo the game's
    ``DisableAllMods`` flag. Returns the mod names whose config could not be
    written (read-only / locked). Best effort -- never raises."""
    path = str(game_path or "").strip()
    if not path:
        return []
    try:
        ensure_mods_enabled()
        mod_list = TroveModList(
            path=TroveGamePath(Path(path)),
            partial=True,
            fix_configs=True,
        )
        return list(mod_list.read_only_configs)
    except Exception:
        return []


class ModWatcher:
    def __init__(self):
        self._lock = threading.Lock()
        self._target = None          # install path currently watched
        self._signature = None       # last signature we consider settled
        self._pending = None         # signature seen once, awaiting confirmation
        self._thread = None
        self._wake = threading.Event()

    def set_target(self, game_path):
        """Point the watch at an install (or None to idle). Re-baselines the
        signature so switching installs never fires a spurious change."""
        path = str(game_path or "").strip() or None
        with self._lock:
            if path == self._target:
                return
            self._target = path
            self._signature = mods_signature(path) if path else None
            self._pending = None
        self._wake.set()
        if path:
            self._ensure_running()

    def _ensure_running(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="mods-watch", daemon=True)
        self._thread.start()

    def _run(self):
        while True:
            self._wake.wait(POLL_SECONDS)
            self._wake.clear()
            try:
                self._tick()
            except Exception:
                pass

    def _tick(self):
        """One comparison pass. Returns the install path when a settled change
        was announced, otherwise None."""
        with self._lock:
            target = self._target
            settled = self._signature
            pending = self._pending
        if not target:
            return None

        current = mods_signature(target)
        if current == settled:
            if pending is not None:
                with self._lock:
                    self._pending = None
            return None
        if current != pending:
            # First sighting of this state -- give it a tick to stop moving (a
            # mod being copied in changes size between polls).
            with self._lock:
                if self._target == target:
                    self._pending = current
            return None

        with self._lock:
            if self._target != target:
                return None
            self._signature = current
            self._pending = None

        probe_configs(target)
        try:
            # Fire-and-forget: the UI may not be up, and nothing here needs a
            # return value.
            eel.receive_mods_changed(target)
        except Exception:
            pass
        return target


watcher = ModWatcher()


@eel.expose
@standardize_response
def set_watched_install(game_path):
    """Point the mods-folder watch at the install the user has selected."""
    watcher.set_target(game_path)
    return resp(True, data={"watching": str(game_path or "") or None})
