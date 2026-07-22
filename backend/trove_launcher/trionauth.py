"""Trion auth surface: obtain and keep alive a launch-ready ticket.

POST https://auth.trionworlds.com/auth/v1_2  (form-encoded, Glyph UA)
  -> body containing "Signature:" IS the ticket.
2FA (if ever demanded) via /multiauth/v1_2; keep-alive via /touch/v1_2.

The ticket is a live credential, so the on-disk cache is encrypted with Windows
DPAPI (CryptProtectData, user scope) reached through ctypes - no extra deps.
"""

from __future__ import annotations

import ctypes
import json
import re
import secrets
import time
from ctypes import wintypes
from pathlib import Path
from typing import Callable

import requests

AUTH_HOST = "https://auth.trionworlds.com"
# The server expires a ticket ~48h after it's issued, so we mint a brand-new one
# once the cached ticket reaches this age (1h safety margin). Between mints we
# /touch it to keep the server session warm.
REAUTH_AFTER_SECONDS = 47 * 3600
SMALL_TICKET_LIMIT = 10_000        # extract compact XML above this (launch buffer)
HARD_ERRORS = ("TICKET_CORRUPT", "TICKET_INVALID", "TOKEN_INVALID", "ACCOUNT_INVALID")


class AuthError(RuntimeError):
    pass


class TwoFactorRequired(AuthError):
    pass


# --- DPAPI (ctypes) ---------------------------------------------------------


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _DataBlob:
    buf = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _blob_bytes(blob: _DataBlob) -> bytes:
    return ctypes.string_at(blob.pbData, blob.cbData)


def dpapi_protect(data: bytes, entropy: bytes | None = None) -> bytes:
    ent = ctypes.byref(_blob(entropy)) if entropy else None
    out = _DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(_blob(data)), None, ent, None, None, 0, ctypes.byref(out)
    ):
        raise ctypes.WinError()
    try:
        return _blob_bytes(out)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def dpapi_unprotect(data: bytes, entropy: bytes | None = None) -> bytes:
    ent = ctypes.byref(_blob(entropy)) if entropy else None
    out = _DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(_blob(data)), None, ent, None, None, 0, ctypes.byref(out)
    ):
        raise ctypes.WinError()
    try:
        return _blob_bytes(out)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


# --- ticket text helpers ----------------------------------------------------


def _strip_cr(ticket: str) -> str:
    return ticket.replace("\r", "")


def touch_body(ticket: str) -> bytes:
    """Reduce the stored ticket to exactly the bytes the server signed."""
    t = _strip_cr(ticket)
    # drop the leading byte-count prefix line: start at Signature:/<?xml
    starts = [i for i in (t.find("Signature:"), t.find("<?xml")) if i != -1]
    if starts:
        t = t[min(starts):]
    # remove the two large optional sections
    for tag in ("storeToken", "accountEntitlements"):
        t = re.sub(rf"<{tag}>.*?</{tag}>", "", t, flags=re.DOTALL)
    return t.rstrip("\n").encode("utf-8")


def small_ticket(ticket: str) -> str | None:
    """Compact signed-XML slice for the launch buffer; None if it doesn't fit."""
    t = _strip_cr(ticket)
    x = t.find("<?xml")
    if x == -1:
        return None
    decl_end = t.find("?>", x)
    if decl_end == -1:
        return None
    m = re.search(r"<([A-Za-z_][\w.\-]*)", t[decl_end + 2:])
    if not m:
        return None
    root = m.group(1)
    close = t.find(f"</{root}>", decl_end)
    if close == -1:
        return None
    sliced = t[x: close + len(f"</{root}>")]
    return sliced if len(sliced) <= SMALL_TICKET_LIMIT else None


def is_valid_ticket(body: str, error_header: str | None) -> bool:
    return not error_header and bool(body) and "Signature:" in body


# --- the client -------------------------------------------------------------


class TrionAuth:
    def __init__(self, *, username: str, password: str, channel: str, user_agent: str,
                 cache_path: Path, macaddr_path: Path, log=print):
        self._username = username
        self._password = password
        self._channel = channel
        self._ua = user_agent
        self._cache_path = Path(cache_path)
        self._macaddr_path = Path(macaddr_path)
        self._log = log
        self._session = requests.Session()
        self._session.headers["User-Agent"] = user_agent

    # -- synthetic device id (persist once) --
    @property
    def mac_addr(self) -> str:
        if self._macaddr_path.exists():
            v = self._macaddr_path.read_text().strip()
            if re.fullmatch(r"[0-9a-f]{12}", v):
                return v
        v = secrets.token_bytes(6).hex()  # 12 lowercase hex chars
        self._macaddr_path.write_text(v)
        return v

    def _form(self, **extra) -> dict:
        body = {
            "username": self._username,
            "password": self._password,
            "channel": self._channel,
            "includeStoreToken": "",
            "includeEntitlements": "false",
            "publicMachine": "0",
            "macAddr": self.mac_addr,
        }
        body.update(extra)
        return body

    # -- cache --
    def _load_cache(self) -> dict | None:
        if not self._cache_path.exists():
            return None
        try:
            raw = self._cache_path.read_bytes()
            try:
                raw = dpapi_unprotect(raw)
            except OSError:
                pass  # was written in plaintext fallback
            rec = json.loads(raw.decode("utf-8"))
            return rec if rec.get("ticket") else None
        except Exception as e:
            self._log(f"[auth] cache unreadable, ignoring: {e}")
            return None

    def _store_cache(self, ticket: str, minted: float | None = None) -> None:
        rec = {"ticket": _strip_cr(ticket),
               "minted": minted if minted is not None else time.time()}
        raw = json.dumps(rec).encode("utf-8")
        try:
            raw = dpapi_protect(raw)
        except OSError as e:
            self._log(f"[auth] DPAPI unavailable, storing plaintext: {e}")
        self._cache_path.write_bytes(raw)

    def _invalidate(self) -> None:
        self._cache_path.unlink(missing_ok=True)

    # -- network --
    def _authenticate(self, token_provider: Callable[[], str] | None) -> str:
        self._log("[auth] full authentication")
        r = self._session.post(f"{AUTH_HOST}/auth/v1_2", data=self._form(), timeout=30)
        need = r.headers.get("X-Trionworlds-Token-Required", "")
        if need and "email" in need.lower():
            if token_provider is None:
                raise TwoFactorRequired("2FA email code required but no token provider set")
            return self._multiauth(token_provider)
        err = r.headers.get("X-Trionworlds-Error")
        if is_valid_ticket(r.text, err):
            return r.text
        raise AuthError(err or (r.text.strip()[:200] if r.text else f"HTTP {r.status_code}"))

    def _multiauth(self, token_provider: Callable[[], str]) -> str:
        for _ in range(3):
            code = token_provider()
            r = self._session.post(f"{AUTH_HOST}/multiauth/v1_2",
                                   data=self._form(token=code), timeout=30)
            err = r.headers.get("X-Trionworlds-Error")
            if r.ok and is_valid_ticket(r.text, err):
                return r.text
            self._log(f"[auth] 2FA rejected: {err or 'invalid'}")
        raise AuthError("2FA failed after retries")

    def _touch(self, ticket: str) -> bool:
        """Keep-alive. Returns True if still valid, False if hard-invalidated."""
        try:
            r = self._session.post(
                f"{AUTH_HOST}/touch/v1_2",
                data=touch_body(ticket),
                headers={"Content-Type": "application/octet-stream"},
                timeout=30,
            )
        except requests.RequestException as e:
            self._log(f"[auth] touch network error: {e}")
            return True  # transient; keep ticket, retry later
        body_up = (r.text or "").upper()
        if any(h in body_up for h in HARD_ERRORS):
            self._log("[auth] touch -> hard invalid")
            return False
        if r.ok:
            return True
        self._log(f"[auth] touch transient HTTP {r.status_code}")
        return True

    # -- public --
    def has_valid_cache(self) -> bool:
        """True when a cached ticket exists and is still within the re-mint
        window (so a launch can proceed without re-entering the password)."""
        rec = self._load_cache()
        if not rec or "minted" not in rec:
            return False
        return (time.time() - rec["minted"]) < REAUTH_AFTER_SECONDS

    def logout(self) -> None:
        """Forget the cached ticket (next launch re-authenticates)."""
        self._invalidate()

    def get_ticket(self, *, token_provider: Callable[[], str] | None = None) -> str:
        """Return a launch-ready ticket.

        Mints a brand-new ticket (full auth) once the cached one is older than
        REAUTH_AFTER_SECONDS — i.e. before the server's ~48h expiry. Within that
        window it reuses the cached ticket and /touches it to keep the session
        warm; a hard-invalid touch forces an immediate re-auth.
        """
        now = time.time()
        rec = self._load_cache()
        age = (now - rec["minted"]) if rec and "minted" in rec else None
        if age is not None and age < REAUTH_AFTER_SECONDS and self._touch(rec["ticket"]):
            ticket = rec["ticket"]            # reuse; the re-mint clock keeps running
        else:
            if age is not None and age >= REAUTH_AFTER_SECONDS:
                self._log(f"[auth] ticket {age / 3600:.1f}h old — minting a fresh one")
            ticket = self._authenticate(token_provider)
            self._store_cache(ticket, now)

        if len(ticket) > SMALL_TICKET_LIMIT:
            compact = small_ticket(ticket)
            if compact:
                self._log(f"[auth] using small ticket ({len(compact)} chars)")
                return compact
        return _strip_cr(ticket)
