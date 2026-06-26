"""Encrypted at-rest storage for the signed-in site account's tokens.

The Discord sign-in (see backend/auth.py) yields a short-lived access token plus
a long-lived refresh token. We persist them so the user stays signed in across
launches, but a 30-day refresh token sitting in plaintext would be a credential
anyone with read access to the AppData folder could lift. So we encrypt the blob
with Windows DPAPI (CryptProtectData) under the current user + machine: the
ciphertext is useless on another account or another PC, and we never have to
manage a key ourselves.

Stored at ModManagerCache/account.bin -- deliberately NOT in settings.json, so
account credentials never ride along with the user-facing settings file.
"""
import json
import sys

from utils.path import get_cache_root

_STORE_NAME = "account.bin"
_ENTROPY = b"BetterTroveTools.site_auth.v1"  # extra DPAPI entropy, tied to this use


def _store_path():
    return get_cache_root() / _STORE_NAME


def _dpapi():
    """Return win32crypt if DPAPI is available on this platform, else None.

    Windows-only. On any other platform (or if pywin32 is missing) we return
    None and the caller treats the account as not-persistable -> logged out.
    """
    if sys.platform != "win32":
        return None
    try:
        import win32crypt  # type: ignore
    except ImportError:
        return None
    return win32crypt


def is_available():
    return _dpapi() is not None


def save_tokens(tokens: dict) -> bool:
    """Encrypt and persist the token dict. Returns False if DPAPI is unavailable
    (nothing is written -- the session simply won't survive a restart)."""
    crypt = _dpapi()
    if crypt is None:
        return False
    raw = json.dumps(tokens).encode("utf-8")
    blob = crypt.CryptProtectData(raw, "BTT site account", _ENTROPY, None, None, 0)
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    return True


def load_tokens():
    """Decrypt and return the stored token dict, or None if absent/unreadable
    (missing file, DPAPI unavailable, tampered ciphertext, or a different user)."""
    crypt = _dpapi()
    if crypt is None:
        return None
    path = _store_path()
    if not path.exists():
        return None
    try:
        blob = path.read_bytes()
        _, raw = crypt.CryptUnprotectData(blob, _ENTROPY, None, None, 0)
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        # Corrupt or undecryptable (e.g. copied from another machine) -> treat
        # as logged out and clear the unusable file so we don't keep retrying.
        clear_tokens()
        return None


def clear_tokens() -> None:
    try:
        _store_path().unlink(missing_ok=True)
    except Exception:
        pass
