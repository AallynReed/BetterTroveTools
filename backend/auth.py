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


def _authed_request(method: str, path: str, json=None, label: str = "Loading your account"):
    """Call an authenticated site endpoint with the bearer token, transparently
    refreshing once on 401. Works for any verb (GET/POST/PATCH/DELETE). Returns
    the requests.Response, or None when not signed in / the request errored."""
    _ensure_loaded()
    access = (_tokens or {}).get("access_token")
    if not access:
        return None
    url = f"{KIWI_API_BASE}{path}"

    def _do(token):
        return requests.request(
            method,
            url,
            json=json,
            headers={"Authorization": f"Bearer {token}", "User-Agent": _USER_AGENT},
            timeout=_TIMEOUT,
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


def _manage_call(method, path, label, json=None, ok_data=None):
    """Run an authed manage request and fold the result into the app envelope.
    Surfaces the server's error code/message on a 4xx/5xx so the UI can show it."""
    if not _require_login():
        return resp(False, error="You need to sign in first.", code="NOT_AUTHENTICATED")
    r = _authed_request(method, path, json=json, label=label)
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
