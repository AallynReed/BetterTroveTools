"""Trove tab backend: a Glyph-free launcher/updater surface for the frontend.

Wraps the vendored ``backend.trove_launcher`` package (update CDN client, ticket
auth, Win32 ticket injection) behind a handful of ``@eel.expose`` calls the
Trove view drives:

  * ``trove_get_state``   - launcher prefs + whether a cached login is still valid.
  * ``trove_check``       - cheap "is there an update?" probe (pointer only).
  * ``trove_update``      - sync the chosen install to the current build.
  * ``trove_repair``      - forget local state and re-download the full manifest.
  * ``trove_play``        - (optionally update, then) authenticate + launch Trove.
  * ``trove_submit_2fa``  - hand a 2-step email code to a waiting ``trove_play``.
  * ``trove_cancel_2fa``  - abort a launch that's waiting on a 2-step code.
  * ``trove_logout``      - drop the cached ticket.

Long operations run on a daemon worker thread (only one at a time, guarded by
``_BUSY``) so the eel handler returns immediately; progress + terminal status are
pushed to the view via the JS-exposed ``receive_trove_progress``. The Win32
launch modules are imported lazily because they bind kernel32/user32 at import
time — Better Trove Tools also runs on Linux, where update-only still works.
"""

from __future__ import annotations

import hashlib
import json
import queue
import threading
import time
from pathlib import Path

import eel

from backend.response import resp, standardize_response
from backend.trove_launcher import trionauth, updater as _updater
from utils.executable import find_trove_executable
from utils.path import get_app_data_dir

# --- constants --------------------------------------------------------------

# Trion's live update CDN (plain HTTP, no auth). The double slash after the
# prefix is deliberate — see trove_launcher/cdn.py.
UPDATE_BASE = "http://trove-update.dyn.triongames.com"
UPDATE_PREFIX = "/kiwi-live-client-patch/"

GLYPH_USER_AGENT = "Glyph (stable-248-1-a-336302)"
GLYPH_CHANNEL = "131"
KEY_FILE = "Trove_x64.exe"
# Reparent the launch under Glyph when it happens to be running, so XIGNCODE's
# server-side attestation sees a genuine-looking ancestry (leaderboards). When
# Glyph isn't running we launch normally — the game still runs, see inject.spawn.
REPARENT_PROCESS = "GlyphClientApp.exe"

# Server key -> (update branch, auth region, human label).
SERVERS = {
    "live-na": ("live-us", "NA", "Live (NA)"),
    "live-eu": ("live-us", "EU", "Live (EU)"),
    "pts": ("pts", "PTS", "PTS"),
}
DEFAULT_SERVER = "live-na"

_CANCEL_2FA = object()  # sentinel put on the 2FA queue to abort a waiting launch


# --- shared worker/2FA state ------------------------------------------------

_STATE_LOCK = threading.Lock()
_BUSY = False
_2FA: dict = {"queue": None}  # single slot; only one op runs at a time


# --- storage/prefs ----------------------------------------------------------


def _storage_dir() -> Path:
    d = get_app_data_dir() / "TroveLauncher"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prefs_path() -> Path:
    return _storage_dir() / "prefs.json"


def _load_prefs() -> dict:
    try:
        return json.loads(_prefs_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_prefs(**changes) -> dict:
    prefs = _load_prefs()
    prefs.update({k: v for k, v in changes.items() if v is not None})
    try:
        _prefs_path().write_text(json.dumps(prefs), encoding="utf-8")
    except Exception:
        pass
    return prefs


def _email_hash(email: str) -> str:
    # Filename discriminator only — never an authentication or integrity check.
    # SHA-256 regardless, so nothing in the tree hands a scanner (or a reader) a
    # reason to think a broken digest is load-bearing somewhere.
    # usedforsecurity=False states that contract to the interpreter as well as
    # to anyone reading, and keeps this usable on FIPS-restricted builds.
    return hashlib.sha256(
        (email or "").strip().lower().encode("utf-8"), usedforsecurity=False
    ).hexdigest()[:12]


def _legacy_email_hash(email: str) -> str:
    # Exists purely to locate files written before the switch to SHA-256, so it
    # can never be replaced with a stronger digest — the old names are already
    # on disk. It computes a filename and nothing else; see _hashed_path.
    return hashlib.sha1(
        (email or "").strip().lower().encode("utf-8"), usedforsecurity=False
    ).hexdigest()[:12]


def _hashed_path(prefix: str, email: str) -> Path:
    """Per-account file path, migrating the pre-SHA-256 name on first use.

    Without the rename, bumping the digest would silently orphan every saved
    ticket and remembered password — each account would look signed out.
    """
    path = _storage_dir() / f"{prefix}-{_email_hash(email)}.bin"
    if not path.exists():
        legacy = _storage_dir() / f"{prefix}-{_legacy_email_hash(email)}.bin"
        if legacy.exists():
            try:
                legacy.rename(path)
            except OSError:
                return legacy  # keep working off the old file if the rename fails
    return path


def _auth_cache_path(email: str = "") -> Path:
    # Per-account ticket cache so several Glyph accounts can each stay signed in.
    if email:
        return _hashed_path("auth", email)
    return _storage_dir() / "auth_cache.bin"


def _macaddr_path() -> Path:
    return _storage_dir() / "macaddr.txt"


# --- saved accounts (list of emails; passwords/tickets stored per-account) ---


def _accounts() -> list:
    out = []
    for a in _load_prefs().get("accounts", []):
        e = a if isinstance(a, str) else (a.get("email") if isinstance(a, dict) else None)
        if e and e not in out:
            out.append(e)
    return out


def _add_account(email: str) -> None:
    email = (email or "").strip()
    if not email:
        return
    accs = [a for a in _accounts() if a.lower() != email.lower()]
    accs.insert(0, email)  # most-recently-used first
    _save_prefs(accounts=accs, selected_email=email, email=email)


def _alias_for(email: str) -> str:
    return (_load_prefs().get("aliases", {}) or {}).get((email or "").strip().lower(), "")


def _mask_email(email: str) -> str:
    """Obfuscate an email for logs: ****@domain (local part hidden)."""
    email = (email or "").strip()
    if "@" not in email:
        return "****" if email else "Trove"
    return "****@" + email.partition("@")[2]


def _display(email: str) -> str:
    """What to show for an account in logs/UI: its custom label if set, else a
    masked email — never the full address."""
    return _alias_for(email) or _mask_email(email)


def _set_alias(email: str, name: str) -> None:
    email = (email or "").strip()
    if not email:
        return
    aliases = dict(_load_prefs().get("aliases", {}) or {})
    name = (name or "").strip()
    if name:
        aliases[email.lower()] = name
    else:
        aliases.pop(email.lower(), None)
    _save_prefs(aliases=aliases)


# --- remembered credentials (DPAPI, user scope) -----------------------------
# The password is encrypted with Windows DPAPI (CryptProtectData, user scope) —
# only this Windows user on this machine can decrypt it, no server, no app-held
# key. We add app-specific entropy for defense in depth, and — unlike the ticket
# cache — we NEVER fall back to plaintext for a password: if DPAPI is
# unavailable we simply don't remember it.
_CRED_ENTROPY = b"BTT.trove.launcher.credentials.v1"


def _cred_path(email: str = "") -> Path:
    if email:
        return _hashed_path("cred", email)
    return _storage_dir() / "credentials.bin"


def _save_credentials(email: str, password: str) -> bool:
    if not password:
        return False
    raw = json.dumps({"email": email or "", "password": password}).encode("utf-8")
    try:
        blob = trionauth.dpapi_protect(raw, _CRED_ENTROPY)
    except Exception:
        return False  # DPAPI unavailable — refuse to store a password in the clear
    try:
        _cred_path(email).write_bytes(blob)
        return True
    except Exception:
        return False


def _load_credentials(email: str = "") -> dict | None:
    p = _cred_path(email)
    if not p.exists():
        return None
    try:
        raw = trionauth.dpapi_unprotect(p.read_bytes(), _CRED_ENTROPY)
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def _clear_credentials(email: str = "") -> None:
    try:
        _cred_path(email).unlink(missing_ok=True)
    except Exception:
        pass


def _has_saved_password(email: str = "") -> bool:
    creds = _load_credentials(email)
    return bool(creds and creds.get("password"))


def _db_path(branch: str, game_dir: Path) -> Path:
    # State is per (branch, install folder): different installs can sit at
    # different versions, so they can't share one "what's on disk" DB.
    key = hashlib.sha1(str(Path(game_dir).resolve()).lower().encode("utf-8")).hexdigest()[:12]
    return _storage_dir() / f"update-{branch}-{key}.sqlite"


def _resolve_server(server: str | None):
    return SERVERS.get(server or DEFAULT_SERVER, SERVERS[DEFAULT_SERVER])


def _resolve_game_dir(game_path: str | None) -> Path:
    if not game_path:
        raise ValueError("No Trove install selected.")
    p = Path(game_path)
    if not p.exists() or not p.is_dir():
        raise ValueError(f"Trove install folder not found: {game_path}")
    return p


def _resolve_exe(game_dir: Path) -> Path:
    exe = find_trove_executable(game_dir)
    return exe if exe is not None else game_dir / KEY_FILE


def _make_auth(email: str, password: str) -> "trionauth.TrionAuth":
    return trionauth.TrionAuth(
        username=email or "", password=password or "",
        channel=GLYPH_CHANNEL, user_agent=GLYPH_USER_AGENT,
        cache_path=_auth_cache_path(email), macaddr_path=_macaddr_path(),
    )


# --- progress plumbing ------------------------------------------------------


def _emit(op: str, stage: str, **fields) -> None:
    """Push one progress/status frame to the Trove view (fire-and-forget)."""
    payload = {"op": op, "stage": stage}
    payload.update(fields)
    try:
        eel.receive_trove_progress(payload)  # JS side is exposed as receive_trove_progress
    except Exception:
        pass  # UI not listening (view not mounted) — nothing to do


def _make_logger(op: str):
    def _log(msg) -> None:
        _emit(op, "log", message=str(msg))
    return _log


def _make_progress(op: str, stage: str = "downloading"):
    """Throttled per-file progress callback for the updater (>=150ms apart, but
    always the final frame)."""
    last = [0.0]

    def _cb(seen: int, total: int, downloaded: int) -> None:
        now = time.monotonic()
        if total and now - last[0] < 0.15 and seen < total:
            return
        last[0] = now
        _emit(op, stage, current=seen, total=total, downloaded=downloaded)
    return _cb


# --- worker scheduling ------------------------------------------------------


def _begin() -> bool:
    global _BUSY
    with _STATE_LOCK:
        if _BUSY:
            return False
        _BUSY = True
        return True


def _finish() -> None:
    global _BUSY
    with _STATE_LOCK:
        _BUSY = False
        _2FA["queue"] = None


def _spawn(op: str, target) -> dict:
    """Run ``target()`` on a daemon thread if no other op is in flight."""
    if not _begin():
        return {"started": False, "error": "busy"}

    def _run() -> None:
        try:
            target()
        except Exception as e:  # noqa: BLE001 — surface any failure to the UI
            _emit(op, "error", done=True, ok=False, error=str(e))
        finally:
            _finish()

    threading.Thread(target=_run, daemon=True, name=f"trove-{op}").start()
    return {"started": True}


# --- update / repair core ---------------------------------------------------


def _run_sync(op: str, game_dir: Path, branch: str, *, adopt: bool, reset: bool,
              emit_done: bool = True):
    """Shared body for update (adopt) and repair (reset + full re-download).

    ``emit_done=False`` suppresses the terminal frame — used when this sync is
    only the update *phase* of a launch, so the frontend doesn't read it as the
    whole Play operation finishing before auth + spawn even run.
    """
    _emit(op, "starting", message="Contacting update server...")
    up = _updater.Updater(base=UPDATE_BASE, prefix=UPDATE_PREFIX, branch=branch,
                          game_dir=game_dir, db_path=_db_path(branch, game_dir),
                          log=_make_logger(op))
    try:
        if reset:
            up.reset()
        result = up.update(key_file=KEY_FILE, adopt=adopt,
                           progress=_make_progress(op))
    finally:
        up.close()
    if emit_done:
        _emit(op, "done", done=True, ok=(result["failed"] == 0),
              version=result["version"], downloaded=result["downloaded"],
              unchanged=result["unchanged"], failed=result["failed"],
              skipped=result.get("skipped", False))
    return result


# --- 2FA provider -----------------------------------------------------------


def _make_token_provider(op: str):
    """A token provider TrionAuth calls when the server demands a 2-step code.
    It signals the UI and blocks the worker thread until trove_submit_2fa (or
    trove_cancel_2fa) feeds the queue."""
    def _provider() -> str:
        q: "queue.Queue" = queue.Queue()
        _2FA["queue"] = q
        _emit(op, "2fa_required",
              message="Enter the 2-step verification code sent to your email.")
        code = q.get()
        _2FA["queue"] = None
        if code is _CANCEL_2FA:
            raise trionauth.AuthError("Launch cancelled at 2-step verification.")
        return str(code).strip()
    return _provider


# --- launched-process tracking + auto-relog ---------------------------------
# We remember which pid was launched for which account. A daemon monitor waits
# for each process to exit; when auto-relog is on and the process died
# ABNORMALLY (non-zero exit code), we sign back in and relaunch. A clean exit
# (code 0 — Alt+F4 / quitting the game) is treated as an intentional close and
# is NOT relogged. A too-short lifetime is ignored to avoid crash-loop relogs.

_LAUNCH_LOCK = threading.Lock()
_LAUNCHES: dict = {}  # pid -> {pid, email, server, game_path, region, branch, auto_relog, started_at, relogs}
_MIN_UPTIME_FOR_RELOG = 25.0  # seconds; a process that dies faster isn't relogged


def _wait_for_exit(pid: int):
    """Block until process `pid` exits; return its exit code (None on error).
    Windows only — reached only from a launch path, which is Windows-only."""
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    SYNCHRONIZE = 0x00100000
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    INFINITE = 0xFFFFFFFF
    k.OpenProcess.restype = wintypes.HANDLE
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    h = k.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return None
    try:
        k.WaitForSingleObject(h, INFINITE)
        code = wintypes.DWORD()
        k.GetExitCodeProcess(h, ctypes.byref(code))
        return int(code.value)
    finally:
        k.CloseHandle(h)


def _running_list() -> list:
    with _LAUNCH_LOCK:
        items = [dict(i) for i in _LAUNCHES.values()]
    now = time.time()
    return [{"pid": i["pid"], "email": i["email"], "label": _display(i["email"]),
             "server": i["server"], "auto_relog": bool(i.get("auto_relog")),
             "relogs": i.get("relogs", 0), "uptime": int(now - i["started_at"])} for i in items]


def _emit_running() -> None:
    _emit("running", "update", instances=_running_list())


def _track_launch(pid: int, info: dict) -> None:
    info = dict(info)
    info["pid"] = pid
    info.setdefault("started_at", time.time())
    info.setdefault("relogs", 0)
    with _LAUNCH_LOCK:
        _LAUNCHES[pid] = info
    _emit_running()
    threading.Thread(target=_monitor_launch, args=(pid,), daemon=True,
                     name=f"trove-mon-{pid}").start()


def _monitor_launch(pid: int) -> None:
    code = _wait_for_exit(pid)
    with _LAUNCH_LOCK:
        info = _LAUNCHES.pop(pid, None)
    if not info:
        return
    uptime = time.time() - info["started_at"]
    clean_close = code == 0
    should_relog = (info.get("auto_relog") and not clean_close and code is not None
                    and uptime >= _MIN_UPTIME_FOR_RELOG)
    who = _display(info["email"])
    if not should_relog:
        if info.get("auto_relog") and clean_close:
            _emit("running", "closed", pid=pid,
                  message=f"{who} closed normally — auto-relog skipped.")
        elif info.get("auto_relog") and uptime < _MIN_UPTIME_FOR_RELOG:
            _emit("running", "closed", pid=pid,
                  message=f"{who} exited after {int(uptime)}s — not relogging (too soon).")
        _emit_running()
        return
    _emit("running", "relog", pid=pid,
          message=f"{who} exited (code {code}) — relogging...")
    _emit_running()
    try:
        _relaunch(info)
    except Exception as e:  # noqa: BLE001
        _emit("running", "relog_failed", error=str(e),
              message=f"Auto-relog for {who} failed: {e}")
        _emit_running()


def _relaunch(info: dict) -> None:
    from backend.trove_launcher import inject, launch as launch_mod
    time.sleep(3.0)  # let the anti-cheat/service settle before relaunching
    creds = _load_credentials(info["email"])
    pw = creds.get("password", "") if creds else ""
    auth = _make_auth(info["email"], pw)
    ticket = auth.get_ticket()  # no token_provider: a background relog can't do 2FA
    exe = _resolve_exe(Path(info["game_path"]))
    pid = inject.spawn(exe, ticket, launch_mod.get_auth_server(info["region"]),
                       parent_process_name=REPARENT_PROCESS, log=_make_logger("relog"))
    new_info = dict(info)
    new_info["started_at"] = time.time()
    new_info["relogs"] = info.get("relogs", 0) + 1
    _track_launch(pid, new_info)
    _emit("running", "relogged", pid=pid,
          message=f"{_display(info['email'])} relogged (pid {pid}).")


# ============================================================================
# Exposed API
# ============================================================================


@eel.expose
@standardize_response
def trove_get_state():
    """Launcher prefs + whether a cached login is still usable + known versions."""
    prefs = _load_prefs()
    logged_in = False
    try:
        logged_in = _make_auth(prefs.get("email", ""), "").has_valid_cache()
    except Exception:
        logged_in = False

    versions = {}
    game_path = prefs.get("game_path")
    if game_path and Path(game_path).is_dir():
        for _key, (branch, _region, _label) in SERVERS.items():
            if branch in versions:
                continue
            try:
                up = _updater.Updater(base=UPDATE_BASE, prefix=UPDATE_PREFIX,
                                      branch=branch, game_dir=Path(game_path),
                                      db_path=_db_path(branch, Path(game_path)))
                try:
                    versions[branch] = up.current_version()
                finally:
                    up.close()
            except Exception:
                versions[branch] = None

    accounts = []
    for e in _accounts():
        try:
            li = _make_auth(e, "").has_valid_cache()
        except Exception:
            li = False
        accounts.append({"email": e, "name": _alias_for(e), "logged_in": li,
                         "has_saved_password": _has_saved_password(e)})

    selected = prefs.get("selected_email") or prefs.get("email", "") or (
        accounts[0]["email"] if accounts else "")
    sel = next((a for a in accounts if a["email"].lower() == (selected or "").lower()), None)

    data = {
        "email": selected,
        "accounts": accounts,
        "selected_email": selected,
        "remember_email": bool(prefs.get("remember_email", bool(prefs.get("email")))),
        "remember_password": bool(prefs.get("remember_password")),
        "has_saved_password": sel["has_saved_password"] if sel else _has_saved_password(selected),
        "auto_relog": bool(prefs.get("auto_relog")),
        "server": prefs.get("server", DEFAULT_SERVER),
        "game_path": game_path or "",
        "logged_in": sel["logged_in"] if sel else logged_in,
        "busy": _BUSY,
        "servers": [{"key": k, "label": lbl} for k, (_b, _r, lbl) in SERVERS.items()],
        "versions": versions,
        "running": _running_list(),
    }
    return resp(True, data=data)


@eel.expose
@standardize_response
def trove_check(game_path, server=DEFAULT_SERVER):
    """Cheap update probe: fetch the branch pointer and compare to local state."""
    branch, _region, _label = _resolve_server(server)
    game_dir = _resolve_game_dir(game_path)

    def _work():
        _emit("check", "starting", message="Checking for updates...")
        up = _updater.Updater(base=UPDATE_BASE, prefix=UPDATE_PREFIX, branch=branch,
                              game_dir=game_dir, db_path=_db_path(branch, game_dir))
        try:
            info = up.check()
            local = up.current_version()
        finally:
            up.close()
        _emit("check", "done", done=True, ok=True, version=info["version"],
              local_version=local, up_to_date=info["up_to_date"])

    return resp(True, data=_spawn("check", _work))


@eel.expose
@standardize_response
def trove_update(game_path, server=DEFAULT_SERVER):
    """Sync the chosen install to the current build (delta download)."""
    branch, _region, _label = _resolve_server(server)
    game_dir = _resolve_game_dir(game_path)
    _save_prefs(server=server, game_path=str(game_dir))
    return resp(True, data=_spawn(
        "update", lambda: _run_sync("update", game_dir, branch, adopt=True, reset=False)))


@eel.expose
@standardize_response
def trove_repair(game_path, server=DEFAULT_SERVER):
    """Forget local state and re-download every file the manifest lists."""
    branch, _region, _label = _resolve_server(server)
    game_dir = _resolve_game_dir(game_path)
    _save_prefs(server=server, game_path=str(game_dir))
    return resp(True, data=_spawn(
        "repair", lambda: _run_sync("repair", game_dir, branch, adopt=False, reset=True)))


@eel.expose
@standardize_response
def trove_play(game_path, server=DEFAULT_SERVER, email="", password="",
               remember_email=True, remember_password=False, update_first=True,
               auto_relog=False):
    """Optionally update, then authenticate and launch Trove without Glyph.

    ``email`` selects which saved account to launch (added to the account list on
    success). ``remember_password``: on success, store this account's password
    encrypted via DPAPI (per-account). ``auto_relog``: monitor the launched
    process and relaunch this account if it exits abnormally (see _monitor_launch).
    """
    branch, region, _label = _resolve_server(server)
    game_dir = _resolve_game_dir(game_path)
    remember_password = bool(remember_password)
    auto_relog = bool(auto_relog)
    remember_email = bool(remember_email) or remember_password  # password implies email
    email = (email or "").strip()
    _save_prefs(server=server, game_path=str(game_dir),
                remember_email=remember_email, remember_password=remember_password,
                auto_relog=auto_relog)
    if email and not remember_password:
        _clear_credentials(email)

    def _work():
        # Lazily imported: these bind kernel32/user32 at import time (Windows only).
        from backend.trove_launcher import inject, launch as launch_mod

        use_email, use_pw = email, password
        if not use_pw:  # blank password -> fall back to this account's saved one
            creds = _load_credentials(use_email)
            if creds:
                use_pw = creds.get("password", "")
                if not use_email:
                    use_email = creds.get("email", "")

        if update_first:
            _emit("play", "updating", message="Updating Trove...")
            _run_sync("play", game_dir, branch, adopt=True, reset=False, emit_done=False)

        exe = _resolve_exe(game_dir)
        if not exe.exists():
            raise FileNotFoundError(
                f"Trove executable not found in {game_dir}. Try Update or Repair first.")

        _emit("play", "authenticating",
              message=f"Signing in{(' as ' + _display(use_email)) if use_email else ''}...")
        auth = _make_auth(use_email, use_pw)
        ticket = auth.get_ticket(token_provider=_make_token_provider("play"))
        # Remember the account (dropdown) and, if asked, its password (per-account).
        _add_account(use_email)
        if remember_password and use_pw:
            _save_credentials(use_email, use_pw)

        _emit("play", "launching", message="Launching Trove...")
        logger = _make_logger("play")
        pid = inject.spawn(exe, ticket, launch_mod.get_auth_server(region),
                           parent_process_name=REPARENT_PROCESS, log=logger)

        # Track this pid <-> account for the running list + auto-relog.
        _track_launch(pid, {"email": use_email, "server": server, "game_path": str(game_dir),
                            "region": region, "branch": branch, "auto_relog": auto_relog})

        # Give the window a moment to appear, then pull it to the foreground.
        time.sleep(2.0)
        try:
            launch_mod.focus_window_by_pid(pid)
        except Exception:
            pass

        _emit("play", "launched", done=True, ok=True, pid=pid, email=use_email,
              message=f"Launched {_display(use_email)} (pid {pid}).")

    return resp(True, data=_spawn("play", _work))


@eel.expose
@standardize_response
def trove_submit_2fa(code):
    """Feed a 2-step email code to a launch waiting at trove_play."""
    q = _2FA.get("queue")
    if q is None:
        return resp(False, error="No launch is waiting for a code.", code="NO_2FA_PENDING")
    q.put(str(code or "").strip())
    return resp(True, data={"accepted": True})


@eel.expose
@standardize_response
def trove_cancel_2fa():
    """Abort a launch that's blocked waiting on a 2-step code."""
    q = _2FA.get("queue")
    if q is not None:
        q.put(_CANCEL_2FA)
    return resp(True, data={"cancelled": True})


@eel.expose
@standardize_response
def trove_set_remember(remember_email=True, remember_password=False, email=""):
    """Persist the 'remember' toggles; forget the given account's stored password
    immediately when password-remember is switched off."""
    remember_email = bool(remember_email) or bool(remember_password)
    remember_password = bool(remember_password)
    email = (email or "").strip() or _load_prefs().get("selected_email", "")
    _save_prefs(remember_email=remember_email, remember_password=remember_password)
    if not remember_password and email:
        _clear_credentials(email)
    return resp(True, data={"remember_email": remember_email,
                            "remember_password": remember_password,
                            "has_saved_password": _has_saved_password(email)})


@eel.expose
@standardize_response
def trove_select_account(email):
    """Mark an account as the active one; report its cached-login state."""
    email = (email or "").strip()
    _save_prefs(selected_email=email, email=email)
    logged_in = False
    try:
        logged_in = _make_auth(email, "").has_valid_cache()
    except Exception:
        logged_in = False
    return resp(True, data={"email": email, "logged_in": logged_in,
                            "has_saved_password": _has_saved_password(email)})


@eel.expose
@standardize_response
def trove_remove_account(email):
    """Forget an account entirely: its ticket cache, saved password, and its
    entry in the dropdown."""
    email = (email or "").strip()
    _clear_credentials(email)
    _set_alias(email, "")  # drop its custom label too
    try:
        _make_auth(email, "").logout()
    except Exception:
        pass
    accs = [a for a in _accounts() if a.lower() != email.lower()]
    prefs = _load_prefs()
    changes = {"accounts": accs}
    if (prefs.get("selected_email", "") or "").lower() == email.lower():
        changes["selected_email"] = accs[0] if accs else ""
        changes["email"] = accs[0] if accs else ""
    _save_prefs(**changes)
    return resp(True, data={"accounts": accs, "selected_email": changes.get("selected_email", "")})


@eel.expose
@standardize_response
def trove_logout(email=""):
    """Drop a single account's cached ticket AND remembered password (keeps the
    account in the dropdown). Defaults to the selected account."""
    email = (email or "").strip() or _load_prefs().get("selected_email", "")
    try:
        _make_auth(email, "").logout()
    except Exception as e:
        return resp(False, error=str(e), code="LOGOUT_FAILED")
    _clear_credentials(email)
    return resp(True, data={"email": email, "logged_in": False, "has_saved_password": False})


@eel.expose
@standardize_response
def trove_rename_account(email, name=""):
    """Set (or clear, if blank) a custom display label for an account. The email
    itself is unchanged — only what the dropdown shows."""
    _set_alias(email, name)
    return resp(True, data={"email": (email or "").strip(), "name": (name or "").strip()})


@eel.expose
@standardize_response
def trove_get_running():
    """The list of currently-tracked launched game processes."""
    return resp(True, data={"instances": _running_list()})


@eel.expose
@standardize_response
def trove_set_auto_relog(pid=None, enabled=True):
    """Toggle auto-relog: for a specific running pid, or (pid omitted) the default
    applied to future launches."""
    enabled = bool(enabled)
    if pid is None:
        _save_prefs(auto_relog=enabled)
    else:
        with _LAUNCH_LOCK:
            info = _LAUNCHES.get(int(pid))
            if info:
                info["auto_relog"] = enabled
        _emit_running()
    return resp(True, data={"auto_relog": enabled})
