"""Trion update-CDN client + the three plaintext layer parsers.

Synchronous `requests` port of TroveAPI/app/trove/updates/cdn.py - the parsers
are copied verbatim (they're pure); only the network client differs so we keep a
`requests`-only dependency set (no httpx).

Layers (all plain HTTP, no auth):
  1. bootstrap pointer  -> current version tag + content path        (per branch)
  2. versioned manifest -> the file set for that build (path, sha1, size)
  3. file               -> the on-disk bytes (write byte-for-byte; do NOT inflate)

The manifest `sha1` is opaque (not recomputable) - used ONLY as a per-file
"did this change?" key, never as a content hash. URL joins reproduce Glyph's
literal double slash after the prefix verbatim; the CDN accepts it.
"""

from __future__ import annotations

import urllib.parse

import requests

# Each branch's bootstrap-pointer filename. (PTS is region-less: kiwi-pts.txt.)
BRANCHES: dict[str, str] = {
    "live-us": "kiwi-live-us.txt",
    "pts": "kiwi-pts.txt",
}


class CdnError(ValueError):
    """Raised on a malformed pointer/manifest or a size mismatch."""


# --- Parsers (pure) --------------------------------------------------------


def parse_pointer(text: str) -> dict:
    """Pipe-delimited bootstrap pointer -> {version, content_path, motd, fields}.

    Field 1 arrives as `content/patchkiwi-live-us01`, but the manifest/file URL
    templates already carry their own `/content/` segment - so the bare path
    (`patchkiwi-live-us01`) is what we keep, to avoid a doubled `/content/content/`.
    """
    fields = text.strip().split("|")
    if len(fields) < 2 or not fields[0].strip() or not fields[1].strip():
        raise CdnError("malformed bootstrap pointer")
    return {
        "version": fields[0].strip(),
        "content_path": fields[1].strip().removeprefix("content/"),
        "motd": fields[3].strip() if len(fields) > 3 else "",
        "fields": fields,
    }


def parse_manifest(text: str) -> tuple[str, list[dict]]:
    """`version <tag>` + `path:sha1:size` lines -> (version, [{path, sha1, size}])."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or not lines[0].startswith("version "):
        raise CdnError("manifest missing 'version' line")
    version = lines[0].removeprefix("version ").strip()
    entries: list[dict] = []
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        try:
            path, sha1, size = line.rsplit(":", 2)  # rsplit: tolerate ':' in odd paths
            entries.append({"path": path.replace("\\", "/"), "sha1": sha1, "size": int(size)})
        except ValueError:
            continue  # skip a malformed line rather than abort the whole manifest
    return version, entries


# --- URL builders ----------------------------------------------------------


def pointer_url(base: str, prefix: str, pointer_file: str) -> str:
    return f"{base}{prefix}/public/{pointer_file}"


def manifest_url(base: str, prefix: str, content_path: str, version: str) -> str:
    return f"{base}{prefix}/content/{content_path}/{version}.manifest"


def file_url(base: str, prefix: str, content_path: str, path: str, sha1: str) -> str:
    quoted = urllib.parse.quote(path)  # keeps '/'; encodes spaces/specials
    return f"{base}{prefix}/content/{content_path}/recovery/{quoted}?sha1={sha1}"


# --- Sync client -----------------------------------------------------------


class CdnClient:
    def __init__(self, base: str, prefix: str, *, timeout: float = 60.0,
                 user_agent: str = "KiwiAPI/1.0"):
        self._base = base
        self._prefix = prefix
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers["User-Agent"] = user_agent

    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "CdnClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def fetch_pointer(self, pointer_file: str) -> dict:
        r = self._session.get(pointer_url(self._base, self._prefix, pointer_file),
                              timeout=self._timeout)
        r.raise_for_status()
        return parse_pointer(r.text)

    def fetch_manifest(self, content_path: str, version: str) -> tuple[str, list[dict]]:
        r = self._session.get(manifest_url(self._base, self._prefix, content_path, version),
                              timeout=self._timeout)
        r.raise_for_status()
        return parse_manifest(r.text)

    def download_file(self, content_path: str, path: str, sha1: str,
                      expected_size: int | None = None) -> bytes:
        """Fetch one file's raw bytes. Verifies length against the manifest size."""
        url = file_url(self._base, self._prefix, content_path, path, sha1)
        r = self._session.get(url, timeout=self._timeout)
        r.raise_for_status()
        data = r.content
        if expected_size is not None and len(data) != expected_size:
            raise CdnError(f"size mismatch for {path}: got {len(data)}, manifest {expected_size}")
        return data
