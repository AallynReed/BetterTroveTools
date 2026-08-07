"""Referer-injecting image proxy for Bilibili thumbnails.

Bilibili blocks hotlinked images without a matching Referer, so the home feed's
thumbnails have to be fetched server-side. That makes this a request forwarder
with a caller-supplied URL — the shape that turns into SSRF the moment the
validation is sloppy, and into stored XSS the moment the response is echoed back
verbatim. The desktop server (main.py) routes through here so the rules live
in exactly one place.

The defence is *reconstruction*, not inspection: nothing the caller sends is
forwarded as-is. The scheme and host of the outbound request come from the
tables below, and the Content-Type we serve is a literal from _IMAGE_TYPES. The
caller only gets to influence the path and query.
"""

from urllib.parse import urlsplit, urlunsplit

import requests

# Bilibili's image CDN. Values are ours, not the caller's — the outbound host is
# always one of these literals, so a hostname that merely *looks* like one
# ("hdslb.com.evil.example", "evil.example/?hdslb.com") can never be reached.
_ALLOWED_HOSTS = frozenset({
    "hdslb.com",
    "i0.hdslb.com",
    "i1.hdslb.com",
    "i2.hdslb.com",
    "s1.hdslb.com",
    "s2.hdslb.com",
    "archive.biliimg.com",
})

# Served Content-Type is looked up here rather than copied from upstream: the
# body comes back on our own origin, so an upstream "text/html" would otherwise
# be same-origin script. SVG is deliberately absent — it scripts.
_IMAGE_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/png": "image/png",
    "image/gif": "image/gif",
    "image/webp": "image/webp",
    "image/avif": "image/avif",
    "image/bmp": "image/bmp",
}

_MAX_BYTES = 16 * 1024 * 1024
_TIMEOUT = 5

_HEADERS = {
    "Referer": "https://www.bilibili.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

# Handed to the browser alongside every proxied image.
RESPONSE_HEADERS = {
    "Cache-Control": "max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


def resolve_image_url(url: str) -> str | None:
    """Rebuild `url` from trusted parts, or None if it isn't a CDN image URL.

    The returned string shares no bytes with the caller's scheme or host: both
    are substituted for constants after the lookup succeeds. Only the path and
    query survive, which is what actually identifies the thumbnail.
    """
    if not url:
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None

    # .hostname drops any userinfo, so "hdslb.com@evil.example" resolves to
    # evil.example and is rejected rather than matching on the decoy.
    host = (parsed.hostname or "").lower().rstrip(".")
    if host not in _ALLOWED_HOSTS:
        return None

    # Pull the literal back out of the set so the outbound host is our value.
    safe_host = next(h for h in _ALLOWED_HOSTS if h == host)
    return urlunsplit(("https", safe_host, parsed.path, parsed.query, ""))


def fetch_image(url: str) -> tuple[int, bytes, str]:
    """Fetch a thumbnail. Returns (status, body, content_type).

    Never raises, and never surfaces upstream error text — the message would be
    attacker-influenced and lands in our own response.
    """
    safe_url = resolve_image_url(url)
    if safe_url is None:
        return 403, b"Forbidden", "text/plain"

    try:
        # allow_redirects=False: a 302 is otherwise a free hop off the allowlist
        # and onto localhost or the LAN.
        resp = requests.get(
            safe_url, headers=_HEADERS, timeout=_TIMEOUT,
            allow_redirects=False, stream=True,
        )
        try:
            if resp.status_code != 200:
                return 502, b"Upstream image unavailable", "text/plain"

            raw_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
            content_type = _IMAGE_TYPES.get(raw_type)
            if content_type is None:
                return 502, b"Upstream response is not an image", "text/plain"

            body = resp.raw.read(_MAX_BYTES + 1, decode_content=True)
            if len(body) > _MAX_BYTES:
                return 502, b"Upstream image too large", "text/plain"
        finally:
            resp.close()
    except Exception:
        return 502, b"Image fetch failed", "text/plain"

    return 200, body, content_type
