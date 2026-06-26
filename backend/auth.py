"""Discord "Sign in with Discord" for the desktop app.

This reuses the SAME server-side OAuth flow as the trove.aallyn.net website
(app/site_auth on the API). The only difference is the final hop: we ask the
API to finish the login inside the app (``?client=app``) so the callback returns
a tiny page that bounces the one-time code into us over the ``btt://`` deep link
(handled by web/js/main.js -> eel.site_auth_complete). We then swap that code for
the real site tokens, store them encrypted (utils/secure_store, DPAPI), and call
the site endpoints with a Bearer header.

Token lifecycle mirrors the website's: a short-lived access token + a single-use
refresh token that rotates on every /refresh. We persist both encrypted so the
user stays signed in across launches.
"""
import webbrowser

import eel
import requests

from backend.home import KIWI_API_BASE  # https://api.aallyn.net/v1
from backend.response import resp, standardize_response
from utils import secure_store

_USER_AGENT = "BetterTroveTools/1.0"
_TIMEOUT = 15

# In-memory mirror of the persisted tokens + the last /me snapshot. Loaded from
# the encrypted store on first use so a restart resumes the session silently.
_tokens: dict | None = None
_user: dict | None = None
_loaded = False


def _ensure_loaded():
    global _tokens, _loaded
    if not _loaded:
        _tokens = secure_store.load_tokens()
        _loaded = True


def _set_tokens(data: dict):
    """Persist a fresh {access_token, refresh_token} pair (from exchange or a
    refresh rotation). Keeps only the fields we need."""
    global _tokens
    _tokens = {
        "access_token": data.get("access_token"),
        "refresh_token": data.get("refresh_token"),
    }
    secure_store.save_tokens(_tokens)


def _clear():
    global _tokens, _user
    _tokens = None
    _user = None
    secure_store.clear_tokens()


def _log_request(label, url):
    """Best-effort mirror into the in-app External Request log (same convention as
    backend/home.py). Never let a UI-bridge hiccup break the auth call."""
    try:
        return eel.add_external_request(label, url)()
    except Exception:
        return None


def _log_done(req_id, success):
    if req_id is None:
        return
    try:
        eel.remove_external_request(req_id, success)()
    except Exception:
        pass


def _refresh() -> bool:
    """Rotate the refresh token for a new access+refresh pair. Single-use: the
    old refresh token is dead once this returns, so we must save the new one."""
    _ensure_loaded()
    refresh = (_tokens or {}).get("refresh_token")
    if not refresh:
        return False
    req_id = _log_request("Refreshing account session", f"{KIWI_API_BASE}/site-auth/refresh")
    try:
        r = requests.post(
            f"{KIWI_API_BASE}/site-auth/refresh",
            json={"refresh_token": refresh},
            headers={"User-Agent": _USER_AGENT},
            timeout=_TIMEOUT,
        )
        _log_done(req_id, r.ok)
        if not r.ok:
            return False
        _set_tokens(r.json())
        return True
    except requests.RequestException:
        _log_done(req_id, False)
        return False


# Owner-view reads (drafts + owner-only fields) live on the site proxy, not the
# /v1 data API — that GET passes viewer=None and never reveals drafts. The site
# proxy reads the same bearer token as the viewer.
_SITE_BASE = "https://trove.aallyn.net/site"
# Longer timeout for uploads (release .tmod / banner images can be a few MB).
_UPLOAD_TIMEOUT = 120


def _authed_request(method, path, json=None, files=None, data=None,
                    base=None, timeout=None, label="Loading your account"):
    """Call an authenticated endpoint with the bearer token, transparently
    refreshing once on 401. Works for any verb and for multipart uploads
    (pass files=/data=). ``base`` overrides the API root (e.g. _SITE_BASE).
    Returns the requests.Response, or None when not signed in / errored."""
    _ensure_loaded()
    access = (_tokens or {}).get("access_token")
    if not access:
        return None
    url = f"{base or KIWI_API_BASE}{path}"

    def _do(token):
        return requests.request(
            method,
            url,
            json=json,
            files=files,
            data=data,
            headers={"Authorization": f"Bearer {token}", "User-Agent": _USER_AGENT},
            timeout=timeout or _TIMEOUT,
        )

    req_id = _log_request(label, url)
    try:
        r = _do(access)
        if r.status_code == 401 and _refresh():
            r = _do((_tokens or {}).get("access_token"))
        _log_done(req_id, r.ok)
        return r
    except requests.RequestException:
        _log_done(req_id, False)
        return None


def _pick_file(title, filetypes, initial_dir=None):
    """Native open-file dialog (Windows tkinter). Returns (path, bytes) or
    (None, None) if cancelled / unavailable. Reads bytes in Python so binary
    never crosses the eel bridge."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception:
        return None, None
    root = tk.Tk()
    root.attributes("-topmost", True)
    root.withdraw()
    try:
        path = filedialog.askopenfilename(title=title, initialdir=initial_dir, filetypes=filetypes)
    finally:
        root.destroy()
    if not path:
        return None, None
    try:
        return path, __import__("pathlib").Path(path).read_bytes()
    except OSError:
        return None, None


def _authed_get(path: str):
    """GET an authenticated site endpoint (thin wrapper over _authed_request)."""
    return _authed_request("GET", path)


def _fetch_me():
    """Fetch + cache the current site user, or None if not signed in / failed."""
    global _user
    r = _authed_get("/site-auth/me")
    if r is None:
        return None
    if r.status_code == 401:
        # Refresh already attempted inside _authed_get and still unauthorized:
        # the session is truly gone (logged out elsewhere / token revoked).
        _clear()
        return None
    if not r.ok:
        return _user  # transient (offline / 5xx): keep any cached snapshot
    _user = r.json()
    return _user


@eel.expose
@standardize_response
def site_auth_begin_login():
    """Open the Discord sign-in in the system browser. The flow finishes by
    deep-linking back into the app (btt://auth/discord?code=...)."""
    url = f"{KIWI_API_BASE}/site-auth/oauth/discord/start?client=app"
    webbrowser.open(url)
    return resp(True, data={"opened": True})


@eel.expose
@standardize_response
def site_auth_complete(code):
    """Swap the one-time deep-link code for real site tokens, then load /me."""
    if not code:
        return resp(False, error="Missing sign-in code", code="MISSING_CODE")
    req_id = _log_request("Completing sign-in", f"{KIWI_API_BASE}/site-auth/oauth/exchange")
    try:
        r = requests.post(
            f"{KIWI_API_BASE}/site-auth/oauth/exchange",
            json={"code": code},
            headers={"User-Agent": _USER_AGENT},
            timeout=_TIMEOUT,
        )
        _log_done(req_id, r.ok)
    except requests.RequestException as exc:
        _log_done(req_id, False)
        return resp(False, error=str(exc), code="EXCHANGE_FAILED")
    if not r.ok:
        return resp(False, error="Sign-in code was invalid or expired", code="EXCHANGE_REJECTED")
    _set_tokens(r.json())
    user = _fetch_me()
    if user is None:
        _clear()
        return resp(False, error="Signed in but couldn't load your account", code="ME_FAILED")
    return resp(True, data={"authenticated": True, "user": user})


@eel.expose
@standardize_response
def site_auth_me():
    """Return the current sign-in state for the Account view / sidebar chip."""
    _ensure_loaded()
    if not (_tokens or {}).get("access_token"):
        return resp(True, data={"authenticated": False, "user": None})
    user = _fetch_me()
    return resp(True, data={"authenticated": user is not None, "user": user})


@eel.expose
@standardize_response
def site_auth_logout():
    """Revoke this device's refresh token server-side and wipe local tokens."""
    _ensure_loaded()
    refresh = (_tokens or {}).get("refresh_token")
    if refresh:
        try:
            requests.post(
                f"{KIWI_API_BASE}/site-auth/logout",
                json={"refresh_token": refresh},
                headers={"User-Agent": _USER_AGENT},
                timeout=_TIMEOUT,
            )
        except requests.RequestException:
            pass  # best-effort: still clear locally
    _clear()
    return resp(True, data={"authenticated": False, "user": None})


# --- Manage my mods / modpacks ------------------------------------------------
# Thin authenticated wrappers over the Mods Hub / Modpacks owner endpoints
# (all gated by the site JWT). The frontend manage tabs in Modder Tools call
# these; heavy studio operations (releases, files, images, entry editor) are
# deep-linked to the website instead of reimplemented here.

def _require_login():
    _ensure_loaded()
    return bool((_tokens or {}).get("access_token"))


def _manage_call(method, path, label, json=None, files=None, data=None,
                 base=None, timeout=None, ok_data=None):
    """Run an authed manage request and fold the result into the app envelope.
    Surfaces the server's error code/message on a 4xx/5xx so the UI can show it."""
    if not _require_login():
        return resp(False, error="You need to sign in first.", code="NOT_AUTHENTICATED")
    r = _authed_request(method, path, json=json, files=files, data=data,
                        base=base, timeout=timeout, label=label)
    if r is None:
        return resp(False, error="Couldn't reach the server.", code="REQUEST_FAILED")
    if r.status_code == 204:
        return resp(True, data=ok_data if ok_data is not None else {"ok": True})
    try:
        body = r.json()
    except ValueError:
        body = None
    if not r.ok:
        detail = ""
        if isinstance(body, dict):
            detail = body.get("detail") or body.get("error") or ""
        return resp(False, error=detail or f"Request failed ({r.status_code}).",
                    code=f"HTTP_{r.status_code}")
    return resp(True, data=body if body is not None else {"ok": True})


@eel.expose
@standardize_response
def site_mods_list():
    """List the signed-in user's own mods (owned + collaborations)."""
    return _manage_call("GET", "/mods/hub/me/projects", "Loading your mods")


@eel.expose
@standardize_response
def site_modpacks_list():
    """List the signed-in user's own modpacks."""
    return _manage_call("GET", "/modpacks/hub/me/projects", "Loading your modpacks")


@eel.expose
@standardize_response
def site_mod_create(title, visibility="draft"):
    return _manage_call("POST", "/mods/hub/projects", "Creating mod",
                        json={"title": title, "visibility": visibility})


@eel.expose
@standardize_response
def site_modpack_create(title, visibility="draft"):
    return _manage_call("POST", "/modpacks/hub/projects", "Creating modpack",
                        json={"title": title, "visibility": visibility})


@eel.expose
@standardize_response
def site_mod_update(handle, slug, patch):
    return _manage_call("PATCH", f"/mods/hub/projects/{handle}/{slug}",
                        "Updating mod", json=patch or {})


@eel.expose
@standardize_response
def site_modpack_update(handle, slug, patch):
    return _manage_call("PATCH", f"/modpacks/hub/projects/{handle}/{slug}",
                        "Updating modpack", json=patch or {})


@eel.expose
@standardize_response
def site_mod_delete(handle, slug):
    return _manage_call("DELETE", f"/mods/hub/projects/{handle}/{slug}", "Deleting mod")


@eel.expose
@standardize_response
def site_modpack_delete(handle, slug):
    return _manage_call("DELETE", f"/modpacks/hub/projects/{handle}/{slug}", "Deleting modpack")


# --- Owner detail (drafts + owner-only fields) via the /site proxy ------------

@eel.expose
@standardize_response
def site_mod_detail(handle, slug):
    return _manage_call("GET", f"/mods/projects/{handle}/{slug}", "Loading mod",
                        base=_SITE_BASE)


@eel.expose
@standardize_response
def site_modpack_detail(handle, slug):
    return _manage_call("GET", f"/modpacks/projects/{handle}/{slug}", "Loading modpack",
                        base=_SITE_BASE)


# --- Mod releases -------------------------------------------------------------

@eel.expose
@standardize_response
def site_mod_releases(handle, slug):
    return _manage_call("GET", f"/mods/projects/{handle}/{slug}/releases",
                        "Loading releases", base=_SITE_BASE)


def _guess_mime(path, default):
    import mimetypes
    return mimetypes.guess_type(path)[0] or default


@eel.expose
@standardize_response
def site_mod_release_upload(handle, slug, meta):
    """Open a .tmod/.zip picker, then upload it as a new release. ``meta`` carries
    tag / title / changelog / status / branch from the UI."""
    if not _require_login():
        return resp(False, error="You need to sign in first.", code="NOT_AUTHENTICATED")
    meta = meta or {}
    tag = (meta.get("tag") or "").strip()
    if not tag:
        return resp(False, error="A version tag is required.", code="MISSING_TAG")
    path, blob = _pick_file("Select a .tmod or .zip release",
                            [("Trove mod / archive", "*.tmod *.zip"), ("All files", "*.*")])
    if not blob:
        return resp(True, data={"cancelled": True})
    fname = __import__("os").path.basename(path)
    files = {"file": (fname, blob, _guess_mime(path, "application/octet-stream"))}
    data = {
        "tag": tag,
        "title": meta.get("title") or "",
        "changelog": meta.get("changelog") or "",
        "status": meta.get("status") or "published",
        "branch": meta.get("branch") or "",
    }
    return _manage_call("POST", f"/mods/hub/projects/{handle}/{slug}/releases/upload",
                        "Uploading release", files=files, data=data, timeout=_UPLOAD_TIMEOUT)


@eel.expose
@standardize_response
def site_mod_release_update(release_id, patch):
    return _manage_call("PATCH", f"/mods/hub/releases/{release_id}",
                        "Updating release", json=patch or {})


@eel.expose
@standardize_response
def site_mod_release_delete(release_id):
    return _manage_call("DELETE", f"/mods/hub/releases/{release_id}", "Deleting release")


# --- Banner images (mods + modpacks) -----------------------------------------

def _upload_banner(path_prefix, handle, slug):
    if not _require_login():
        return resp(False, error="You need to sign in first.", code="NOT_AUTHENTICATED")
    path, blob = _pick_file("Select a banner image",
                            [("Images", "*.png *.jpg *.jpeg *.webp *.gif"), ("All files", "*.*")])
    if not blob:
        return resp(True, data={"cancelled": True})
    fname = __import__("os").path.basename(path)
    files = {"file": (fname, blob, _guess_mime(path, "image/png"))}
    return _manage_call("POST", f"{path_prefix}/projects/{handle}/{slug}/banner",
                        "Uploading banner", files=files, timeout=_UPLOAD_TIMEOUT)


@eel.expose
@standardize_response
def site_mod_banner_upload(handle, slug):
    return _upload_banner("/mods/hub", handle, slug)


@eel.expose
@standardize_response
def site_modpack_banner_upload(handle, slug):
    return _upload_banner("/modpacks/hub", handle, slug)


# --- Collaborators (mods + modpacks) -----------------------------------------

@eel.expose
@standardize_response
def site_mod_collaborator_add(handle, slug, username):
    return _manage_call("POST", f"/mods/hub/projects/{handle}/{slug}/collaborators",
                        "Adding collaborator", json={"username": username})


@eel.expose
@standardize_response
def site_mod_collaborator_remove(handle, slug, user_id):
    return _manage_call("DELETE", f"/mods/hub/projects/{handle}/{slug}/collaborators/{user_id}",
                        "Removing collaborator")


@eel.expose
@standardize_response
def site_modpack_collaborator_add(handle, slug, username):
    return _manage_call("POST", f"/modpacks/hub/projects/{handle}/{slug}/collaborators",
                        "Adding collaborator", json={"username": username})


@eel.expose
@standardize_response
def site_modpack_collaborator_remove(handle, slug, user_id):
    return _manage_call("DELETE", f"/modpacks/hub/projects/{handle}/{slug}/collaborators/{user_id}",
                        "Removing collaborator")


# --- Modpack variants + entries ----------------------------------------------

@eel.expose
@standardize_response
def site_modpack_variant_create(handle, slug, name, copy_from=None):
    body = {"name": name}
    if copy_from:
        body["copy_from"] = copy_from
    return _manage_call("POST", f"/modpacks/hub/projects/{handle}/{slug}/variants",
                        "Creating variant", json=body)


@eel.expose
@standardize_response
def site_modpack_variant_update(handle, slug, name, label):
    return _manage_call("PATCH", f"/modpacks/hub/projects/{handle}/{slug}/variants/{name}",
                        "Renaming variant", json={"label": label})


@eel.expose
@standardize_response
def site_modpack_variant_delete(handle, slug, name):
    return _manage_call("DELETE", f"/modpacks/hub/projects/{handle}/{slug}/variants/{name}",
                        "Deleting variant")


@eel.expose
@standardize_response
def site_modpack_set_entries(handle, slug, name, entries):
    return _manage_call("PUT", f"/modpacks/hub/projects/{handle}/{slug}/variants/{name}/entries",
                        "Saving mod list", json={"entries": entries or []})


# --- Helpers for the modpack entry editor (search hub + branch list) ----------

@eel.expose
@standardize_response
def site_hub_search(q, limit=20):
    q = (q or "").strip()
    path = f"/mods?q={requests.utils.quote(q)}&sort=downloads&limit={int(limit)}" if q \
        else f"/mods?sort=downloads&limit={int(limit)}"
    return _manage_call("GET", path, "Searching mods")


@eel.expose
@standardize_response
def site_mod_branches(handle, slug):
    return _manage_call("GET", f"/mods/hub/projects/{handle}/{slug}/branches",
                        "Loading variants")


# --- Giveaways (join + my entries) -------------------------------------------

@eel.expose
@standardize_response
def site_giveaway_enter(giveaway_id):
    """Enter the signed-in user into an open giveaway. Idempotent server-side
    (a second call just returns success)."""
    return _manage_call("POST", f"/giveaways/{giveaway_id}/enter", "Entering giveaway")


@eel.expose
@standardize_response
def site_giveaway_mine():
    """The giveaway ids the signed-in user has already entered."""
    return _manage_call("GET", "/giveaways/mine", "Loading your giveaways")
