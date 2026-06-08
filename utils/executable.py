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

def _validate_pe_header(filepath: Path) -> tuple[bool, bool]:
    """Header-only PE check (no full file read): confirms a GUI executable and
    reports 64-bit-ness. Used for the by-name fast path where the filename is
    itself the Trove identifier, so the full-content identifier scan in
    analyze_trove_exe is unnecessary."""
    try:
        with open(filepath, "rb") as f:
            if f.read(2) != b"MZ":
                return False, False
            f.seek(0x3C)
            pe_offset = struct.unpack("<I", f.read(4))[0]
            f.seek(pe_offset)
            if f.read(4) != b"PE\0\0":
                return False, False
            machine = struct.unpack("<H", f.read(2))[0]
            f.seek(pe_offset + 22)
            characteristics = struct.unpack("<H", f.read(2))[0]
            if not (characteristics & 0x0002):
                return False, False
            f.seek(pe_offset + 24 + 68)
            subsystem = struct.unpack("<H", f.read(2))[0]
            if subsystem != 2:
                return False, False
            return True, (machine == 0x8664)
    except Exception:
        return False, False


def _ensure_devtool(game_directory: Path, selected_exe: Path) -> None:
    devtool_path = game_directory / "devtool.bat"
    if devtool_path.exists() and devtool_path.is_file():
        expected_content = f'"%~dp0{selected_exe.name}" -tool %*'
        try:
            if devtool_path.read_text(encoding="utf-8").strip() != expected_content:
                devtool_path.write_text(expected_content, encoding="utf-8")
        except OSError:
            pass


def _resolve_trove_executable(game_directory: Path) -> Path | None:
    # Fast path: the canonical names ARE the identifier, so a cheap header-only
    # check is enough -- no need to read the whole (~21 MB) exe. Trove_x64.exe is
    # tried first so the 64-bit build is preferred.
    for name in ("Trove_x64.exe", "Trove.exe"):
        candidate = game_directory / name
        if candidate.is_file():
            ok, _is64 = _validate_pe_header(candidate)
            if ok:
                return candidate

    # Fallback: a renamed/non-standard exe -- scan every exe with the full
    # identifier check (reads file bodies, but this is the uncommon case).
    candidates = []
    for file in game_directory.glob("*.exe"):
        is_valid, is_64bit = analyze_trove_exe(file)
        if is_valid:
            candidates.append((file, is_64bit))
    if not candidates:
        return None
    for exe, is_64bit in candidates:
        if is_64bit:
            return exe
    return candidates[0][0]


# Resolving WHICH file is the Trove exe only changes when exes are added/removed
# or renamed -- all of which bump the directory's mtime (in-place content updates
# do NOT, and don't need to, since the exe's identity is unchanged). So caching
# by (dir, dir-mtime) is safe and lets repeated get_settings() calls skip the
# glob + per-file PE checks entirely.
_EXE_CACHE: dict = {}  # (dir_str, dir_mtime_ns) -> Path | None


def find_trove_executable(game_directory: Path) -> Path | None:
    if not game_directory.exists() or not game_directory.is_dir():
        return None

    try:
        dir_mtime = game_directory.stat().st_mtime_ns
    except OSError:
        dir_mtime = 0
    key = (str(game_directory), dir_mtime)
    if key in _EXE_CACHE:
        return _EXE_CACHE[key]

    selected_exe = _resolve_trove_executable(game_directory)
    if selected_exe is not None:
        _ensure_devtool(game_directory, selected_exe)

    # Writing devtool.bat can bump the dir mtime; cache under the final mtime so
    # the next call hits the cache instead of re-resolving.
    try:
        final_mtime = game_directory.stat().st_mtime_ns
    except OSError:
        final_mtime = dir_mtime
    _EXE_CACHE[(str(game_directory), final_mtime)] = selected_exe
    _EXE_CACHE[key] = selected_exe
    return selected_exe
