import hashlib
import json
import os
import shutil
import struct
from pathlib import Path

def analyze_trove_exe(filepath: Path) -> tuple[bool, bool]:
    try:
        with open(filepath, 'rb') as f:
            if f.read(2) != b'MZ':
                return False, False
            
            f.seek(0x3C)
            pe_offset_bytes = f.read(4)
            pe_offset = struct.unpack('<I', pe_offset_bytes)[0]
            
            f.seek(pe_offset)
            if f.read(4) != b'PE\0\0':
                return False, False
                
            machine_bytes = f.read(2)
            machine = struct.unpack('<H', machine_bytes)[0]
            
            f.seek(pe_offset + 22)
            characteristics = struct.unpack('<H', f.read(2))[0]
            if not (characteristics & 0x0002):
                return False, False
                
            f.seek(pe_offset + 24 + 68)
            subsystem = struct.unpack('<H', f.read(2))[0]
            if subsystem != 2:
                return False, False
            
            f.seek(0)
            content = f.read()
            
            valid_identifiers = [
                "Trove.exe".encode('utf-16-le'),
                "Trove_x64.exe".encode('utf-16-le'),
                b"Trove.exe",
                b"Trove_x64.exe"
            ]
            
            if not any(ident in content for ident in valid_identifiers):
                return False, False
            
            is_64bit = (machine == 0x8664)
            return True, is_64bit
    except Exception:
        return False, False

def find_trove_executable(game_directory: Path) -> Path | None:
    if not game_directory.exists() or not game_directory.is_dir():
        return None
        
    candidates = []
    
    for file in game_directory.glob("*.exe"):
        is_valid, is_64bit = analyze_trove_exe(file)
        if is_valid:
            candidates.append((file, is_64bit))
                
    if not candidates:
        return None
        
    selected_exe = None
    for exe, is_64bit in candidates:
        if is_64bit:
            selected_exe = exe
            break
            
    if not selected_exe:
        selected_exe = candidates[0][0]

    devtool_path = game_directory / "devtool.bat"
    if devtool_path.exists() and devtool_path.is_file():
        expected_content = f'"%~dp0{selected_exe.name}" -tool %*'
        if devtool_path.read_text(encoding="utf-8").strip() != expected_content:
            devtool_path.write_text(expected_content, encoding="utf-8")

    return selected_exe

# --- FPS cap patching -------------------------------------------------------
#
# Trove caps frame rate with a hardcoded double = 1/120s stored in .rdata. The
# value lives in a small descriptor: [ptr8][ptr8][value8][zero8]. We locate the
# slot WITHOUT a hardcoded offset (offsets differ per build) by searching for a
# known FPS double and confirming the surrounding structure, then read/write the
# 8-byte value IN PLACE at that offset.
#
# "Uncapped" is written as 1/9999s (UNCAPPED_FPS), NOT 0.0. A real value keeps
# the slot findable by the same search as every other cap -- writing 00*8 would
# make it unfindable (zeros occur everywhere), which is why a blind
# bytes.replace() approach breaks the moment you uncap.
#
# A per-install backup + metadata lives in %APPDATA%/Trove/ModManagerCache/
# binary_cache. The metadata (offset + anchor + build identity) lets us recover
# the slot even if a file was hand-edited to an unknown value, and lets us tell
# when a cached backup is outdated (game updated -> different size/timestamp).
# If neither a content search nor the cache can locate the slot, callers get a
# "needs_repair" signal so the UI can ask the user to verify/repair via Glyph.

UNCAPPED_FPS = 9999            # 1/9999s frame target == effectively no cap, and stays searchable
STOCK_FPS = 120                # Trove's hardcoded default
FPS_OPTIONS = [60, 90, 120, 144, 165, 180, 200, 240, 360, 540]  # selectable caps (+ UNCAPPED_FPS)

# Doubles tried to LOCATE the slot by content. Stock 120 exists on every fresh
# build; the rest are values this tool may write. Reading a located value never
# depends on this list.
_LOCATE_FPS = [STOCK_FPS] + [f for f in FPS_OPTIONS if f != STOCK_FPS] + [UNCAPPED_FPS]

_CACHE_SUBDIR = ("Trove", "ModManagerCache", "binary_cache")
_MEMO: dict = {}   # (resolved_path, size, mtime_ns) -> fps  (per-process read cache)


# -- structural slot detection ----------------------------------------------
def _is_image_ptr(data: bytes, i: int) -> bool:
    # 8-byte little-endian pointer into the image (base 0x1'4000'0000 .. 0x1'42xx'xxxx).
    return (
        i + 8 <= len(data)
        and data[i + 4] == 0x01
        and data[i + 5] == 0
        and data[i + 6] == 0
        and data[i + 7] == 0
        and 0x40 <= data[i + 3] <= 0x42
    )


def _is_cap_slot(data: bytes, p: int) -> bool:
    # Descriptor shape: [ptr8][ptr8][value8 @ p][zero8]. We validate the two
    # leading pointers and the trailing zero qword; the value itself is wild.
    if p < 16 or p + 16 > len(data):
        return False
    if data[p + 8:p + 16] != b"\x00" * 8:
        return False
    return _is_image_ptr(data, p - 16) and _is_image_ptr(data, p - 8)


def _find_fps_slot(content: bytes) -> int | None:
    """Locate the 8-byte FPS value by content search, or None if not findable."""
    for fps in _LOCATE_FPS:
        needle = struct.pack("<d", 1.0 / fps)
        start, valid = 0, []
        while True:
            i = content.find(needle, start)
            if i < 0:
                break
            if _is_cap_slot(content, i):
                valid.append(i)
            start = i + 1
        if len(valid) == 1:
            return valid[0]
    return None


def _fps_from_value(value: bytes) -> int:
    """Decode the 8-byte double into an FPS int. 0.0 (legacy uncap) -> UNCAPPED_FPS."""
    seconds = struct.unpack("<d", value)[0]
    if seconds <= 0.0:
        return UNCAPPED_FPS
    return int(round(1.0 / seconds))


# -- build identity & on-disk cache ------------------------------------------
def _pe_timestamp(content: bytes) -> int:
    """COFF TimeDateStamp -- changes between builds; cheap build fingerprint."""
    try:
        pe = struct.unpack_from("<I", content, 0x3C)[0]
        if content[pe:pe + 4] != b"PE\0\0":
            return 0
        return struct.unpack_from("<I", content, pe + 8)[0]
    except Exception:
        return 0


def _cache_dir() -> Path:
    base = os.getenv("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    d = Path(base).joinpath(*_CACHE_SUBDIR)
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return d


def _index_path() -> Path:
    return _cache_dir() / "index.json"


def _read_index() -> dict:
    try:
        return json.loads(_index_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_index(index: dict) -> None:
    try:
        _index_path().write_text(json.dumps(index, indent=2), encoding="utf-8")
    except OSError as e:
        print(f"[FPS] Could not write cache index: {e}")


def _install_key(exe_path: Path) -> str:
    return hashlib.sha1(str(exe_path.resolve()).lower().encode("utf-8")).hexdigest()[:16]


def _backup_file(key: str) -> Path:
    return _cache_dir() / f"{key}.exe.bak"


def _resolve_slot(exe_path: Path, content: bytes) -> int | None:
    """Find the slot offset for `content`. Tries a content search first, then the
    cached offset/anchor for the same build. None => caller should ask for repair."""
    offset = _find_fps_slot(content)
    if offset is not None:
        return offset

    # Recovery for hand-edited/unknown values: cached offset for the SAME build,
    # validated by the anchor (the 16 bytes before the value never change).
    rec = _read_index().get(_install_key(exe_path))
    if rec and rec.get("size") == len(content):
        off = rec.get("offset")
        try:
            anchor = bytes.fromhex(rec.get("anchor", ""))
        except ValueError:
            anchor = b""
        if (
            isinstance(off, int)
            and 16 <= off
            and off + 8 <= len(content)
            and len(anchor) == 16
            and content[off - 16:off] == anchor
        ):
            return off
    return None


def _sync_cache(exe_path: Path, content: bytes, offset: int) -> None:
    """Record offset/anchor/build-identity for this install, and snapshot a
    pristine backup the first time we see a stock (120 FPS) build of it."""
    key = _install_key(exe_path)
    size, ts = len(content), _pe_timestamp(content)
    index = _read_index()
    rec = dict(index.get(key, {}))
    before = dict(rec)

    rec.update({
        "path": str(exe_path),
        "size": size,
        "pe_timestamp": ts,
        "offset": offset,
        "anchor": content[offset - 16:offset].hex(),
    })

    # Pristine snapshot only from an unmodified (stock) exe, refreshed when the
    # build changes (different size/timestamp) or the backup file is missing.
    backup = _backup_file(key)
    if _fps_from_value(content[offset:offset + 8]) == STOCK_FPS:
        build_changed = rec.get("backup_size") != size or rec.get("backup_timestamp") != ts
        if build_changed or not backup.exists():
            try:
                shutil.copy2(exe_path, backup)
                rec["backup"] = backup.name
                rec["backup_size"] = size
                rec["backup_timestamp"] = ts
                rec["backup_fps"] = STOCK_FPS
            except OSError as e:
                print(f"[FPS] Backup snapshot failed: {e}")

    if rec != before:
        index[key] = rec
        _write_index(index)


def backup_is_stale(exe_path: Path) -> bool:
    """True if a cached backup exists but was taken from a different game build
    than the one currently installed (i.e. the game has since updated)."""
    if not exe_path or not exe_path.exists():
        return False
    rec = _read_index().get(_install_key(exe_path))
    if not rec or not rec.get("backup") or not _backup_file(_install_key(exe_path)).exists():
        return False
    try:
        content = exe_path.read_bytes()
    except OSError:
        return False
    return rec.get("backup_size") != len(content) or rec.get("backup_timestamp") != _pe_timestamp(content)


def fps_needs_repair(exe_path: Path) -> bool:
    """True if the exe exists but the FPS slot can't be located by search or
    cache -- the user should verify/repair the install via Glyph."""
    if not exe_path or not exe_path.exists():
        return False
    try:
        content = exe_path.read_bytes()
    except OSError:
        return False
    return _resolve_slot(exe_path, content) is None


def get_current_fps(exe_path: Path) -> int | None:
    """Read the current FPS cap (UNCAPPED_FPS == uncapped). None means the slot
    could not be located -> the install likely needs a repair."""
    if not exe_path or not exe_path.exists():
        return None
    try:
        st = exe_path.stat()
        memo_key = (str(exe_path.resolve()).lower(), st.st_size, st.st_mtime_ns)
        if memo_key in _MEMO:
            return _MEMO[memo_key]
        content = exe_path.read_bytes()
        offset = _resolve_slot(exe_path, content)
        if offset is None:
            return None
        _sync_cache(exe_path, content, offset)
        fps = _fps_from_value(content[offset:offset + 8])
        _MEMO[memo_key] = fps
        return fps
    except Exception:
        return None


def patch_trove_fps(exe_path: Path, target_fps: int) -> tuple[bool, str]:
    """Set the FPS cap in place at the located offset. target_fps of 0 or
    UNCAPPED_FPS both uncap (stored as 1/9999s)."""
    if not exe_path or not exe_path.exists():
        return False, "invalid_args"
    if target_fps in (0, UNCAPPED_FPS):
        target_fps = UNCAPPED_FPS
    elif target_fps < 0:
        return False, "invalid_args"

    target_bytes = struct.pack("<d", 1.0 / target_fps)

    try:
        content = bytearray(exe_path.read_bytes())
        offset = _resolve_slot(exe_path, bytes(content))
        if offset is None:
            print(f"[FPS Patch] '{exe_path.name}' | Slot not found by search or cache -> needs repair.")
            return False, "needs_repair"

        # Snapshot pristine backup / refresh metadata before changing anything.
        _sync_cache(exe_path, bytes(content), offset)

        current = bytes(content[offset:offset + 8])
        label = "uncapped" if target_fps == UNCAPPED_FPS else f"{target_fps} FPS"
        if current == target_bytes:
            print(f"[FPS Patch] '{exe_path.name}' already {label}.")
            return True, ""

        old = _fps_from_value(current)
        old_label = "uncapped" if old == UNCAPPED_FPS else f"{old} FPS"
        print(f"[FPS Patch] '{exe_path.name}' @ 0x{offset:X} | {old_label} -> {label} "
              f"({current.hex(' ').upper()} -> {target_bytes.hex(' ').upper()})")

        content[offset:offset + 8] = target_bytes
        exe_path.write_bytes(bytes(content))
        _MEMO.clear()
        return True, ""
    except Exception as e:
        print(f"[FPS Patch] Error patching '{exe_path.name}': {e}")
        return False, "error"


def restore_trove_fps(exe_path: Path) -> bool:
    """Restore from the cached backup if it matches the current build; otherwise
    reset the cap to stock 120 FPS (equivalent, since FPS is all we modify)."""
    if not exe_path or not exe_path.exists():
        return False
    try:
        content = exe_path.read_bytes()
    except OSError:
        return False

    key = _install_key(exe_path)
    rec = _read_index().get(key)
    backup = _backup_file(key)
    if (
        rec
        and backup.exists()
        and rec.get("backup_size") == len(content)
        and rec.get("backup_timestamp") == _pe_timestamp(content)
    ):
        try:
            shutil.copy2(backup, exe_path)
            _MEMO.clear()
            print(f"[FPS Patch] '{exe_path.name}' restored from cached backup.")
            return True
        except OSError as e:
            print(f"[FPS Patch] Restore from backup failed ({e}); resetting cap instead.")

    success, _ = patch_trove_fps(exe_path, STOCK_FPS)
    return success