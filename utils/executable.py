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