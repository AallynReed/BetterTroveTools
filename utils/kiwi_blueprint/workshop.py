"""The archive reading/writing half of KiwiAPI's ``app/trove/mods_hub/workshop.py``."""
from __future__ import annotations

import base64
import io
import zipfile
from collections.abc import Sequence

from utils.kiwi_blueprint import tmod

MAX_FILES = 4000
MAX_UNPACKED_BYTES = 192 * 1024 * 1024
_JUNK_NAMES = frozenset({".ds_store", "thumbs.db", "desktop.ini", ".gitkeep"})
_JUNK_DIRS = ("__macosx/", ".git/", ".svn/")


class WorkshopError(ValueError):
    """Bad input from the page."""


def norm_path(path: str) -> str:
    parts = [p for p in str(path or "").replace("\\", "/").split("/") if p and p != "."]
    return "/".join(p for p in parts if p != "..")


def is_junk(path: str) -> bool:
    low = path.lower()
    return (low.rsplit("/", 1)[-1] in _JUNK_NAMES
            or any(low == d[:-1] or low.startswith(d) for d in _JUNK_DIRS))


def read_zip(data: bytes) -> list[tuple[str, bytes]]:
    out: list[tuple[str, bytes]] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = [i for i in zf.infolist()
                     if not i.is_dir() and not is_junk(norm_path(i.filename))]
            if len(infos) > MAX_FILES:
                raise WorkshopError(
                    f"That .zip holds more than {MAX_FILES} files - too many for one mod.")
            if sum(i.file_size for i in infos) > MAX_UNPACKED_BYTES:
                raise WorkshopError(
                    f"That .zip unpacks to more than {MAX_UNPACKED_BYTES // (1024 * 1024)} MB.")
            for info in infos:
                path = norm_path(info.filename)
                if path:
                    out.append((path, zf.read(info)))
    except (zipfile.BadZipFile, RuntimeError, OSError) as e:
        raise WorkshopError(f"That .zip couldn't be opened: {e}") from e
    if not out:
        raise WorkshopError("That .zip has no files in it.")
    return out


def read_mod(data: bytes) -> tuple[dict[str, str], list[tuple[str, bytes]]]:
    try:
        parsed = tmod.read_tmod(data)
    except tmod.TmodError as e:
        raise WorkshopError(f"That isn't a readable .tmod file: {e}") from e
    props = {str(k): str(v) for k, v in (parsed.get("properties") or {}).items()}
    files = [(norm_path(f["path"]), base64.b64decode(f["content_base64"] or ""))
             for f in parsed.get("files", [])]
    return props, [(p, b) for p, b in files if p]


def looks_like_zip(data: bytes, filename: str = "") -> bool:
    return data[:2] == b"PK" or (filename or "").lower().endswith(".zip")


def read_archive(data: bytes, filename: str = "",
                 ) -> tuple[str, dict[str, str], list[tuple[str, bytes]]]:
    """Unpack a ``.zip`` or ``.tmod`` into ``(kind, header, files)``."""
    if not data:
        raise WorkshopError("That file is empty.")
    if looks_like_zip(data, filename):
        return "zip", {}, read_zip(data)
    props, files = read_mod(data)
    if not files:
        raise WorkshopError("That .tmod has no files packed in it.")
    return "tmod", props, files


def to_zip(files: Sequence[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in files:
            zf.writestr(path, content)
    return buf.getvalue()
