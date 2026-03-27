import base64
import re
import shutil
import tkinter as tk
from datetime import UTC, datetime
from pathlib import Path
from tkinter import filedialog

import eel
from binary_reader import BinaryReader

from models.trove.directory import Directories
from models.trove.mod import TMod, TroveModFile


@eel.expose
def ask_mod_source_directory():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Mod Source Folder")
    root.destroy()
    return folder_path

@eel.expose
def ask_tmod_file():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.askopenfilename(title="Select TMod File", filetypes=[("Trove Mods", "*.tmod")])
    root.destroy()
    return file_path

@eel.expose
def ask_extract_destination():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Extraction Destination")
    root.destroy()
    return folder_path

@eel.expose
def ask_add_files(game_path_str=None):
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_paths = filedialog.askopenfilenames(title="Select Files to Add")
    root.destroy()
    
    files = []
    rejected = []
    if not file_paths:
        return {"success": True, "files": files, "rejected": rejected}
        
    try:
        game_path = Path(game_path_str).resolve() if game_path_str else None
    except Exception:
        game_path = None
        
    valid_dirs = [d.value.lower() for d in Directories]
        
    for p in file_paths:
        file_path = Path(p).resolve()
        internal_path = file_path.name
        
        is_relative = False
        internal_parts = []
        
        if game_path:
            try:
                rel_parts = file_path.relative_to(game_path).parts
                is_relative = True
                internal_parts = [part for part in rel_parts if part.lower() != "override"]
            except ValueError:
                file_str = str(file_path).lower()
                game_str = str(game_path).lower()
                if file_str.startswith(game_str):
                    is_relative = True
                    rel_path_str = str(file_path)[len(str(game_path)):].strip("\\/")
                    rel_parts = Path(rel_path_str).parts
                    internal_parts = [part for part in rel_parts if part.lower() != "override"]
                else:
                    is_relative = False
                    
        if not is_relative or not internal_parts:
            rejected.append(file_path.name)
        else:
            root_dir = internal_parts[0].lower()
            if root_dir not in valid_dirs:
                rejected.append(file_path.name)
            else:
                internal_path = "/".join(internal_parts)
                files.append({
                    "path": str(file_path),
                    "internal_path": internal_path
                })
            
    return {"success": True, "files": files, "rejected": rejected}

@eel.expose
def extract_tmod(tmod_path_str, dest_path_str):
    try:
        tmod_path = Path(tmod_path_str)
        dest_path = Path(dest_path_str)
        
        if not tmod_path.exists() or not tmod_path.is_file():
            return {"success": False, "error": "TMod file does not exist."}
            
        dest_path.mkdir(parents=True, exist_ok=True)
        
        file_data = tmod_path.read_bytes()
        mod = TMod.read_bytes(tmod_path, file_data)
        
        extracted_count = 0
        for file in mod.files:
            out_path = dest_path / Path(file.trove_path.replace("\\", "/"))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            
            out_path.write_bytes(file.data)
            extracted_count += 1
            
        return {"success": True, "count": extracted_count}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def detect_override_files(source_dir_str):
    try:
        source_dir = Path(source_dir_str)
        if not source_dir.exists() or not source_dir.is_dir():
            return {"success": False, "error": "Invalid source directory."}
            
        valid_dirs = [d.value.lower() for d in Directories]
        files = []
        
        for file_path in source_dir.rglob("*"):
            if file_path.is_file():
                parts = file_path.relative_to(source_dir).parts
                if "override" in [p.lower() for p in parts]:
                    internal_parts = [p for p in parts if p.lower() != "override"]
                    
                    if internal_parts:
                        root_dir = internal_parts[0].lower()
                        if root_dir in valid_dirs:
                            internal_path = "/".join(internal_parts)
                            files.append({
                                "path": str(file_path),
                                "internal_path": internal_path
                            })
                    
        return {"success": True, "files": files}
    except Exception as e:
        return {"success": False, "error": str(e)}

@eel.expose
def auto_structure_workspace(workspace_dir_str, game_path_str):
    try:
        game_path = Path(game_path_str)
        workspace = Path(workspace_dir_str)
        
        if not game_path.exists() or not workspace.exists():
            return {"success": False, "error": "Invalid game path or workspace directory."}
            
        file_map = {}
        valid_dirs = [d.value.lower() for d in Directories]
        
        def _local_read_leb128(reader: BinaryReader):
            result = 0
            shift = 0
            while True:
                byte = reader.read_uint8()
                result |= (byte & 0x7F) << shift
                if not (byte & 0x80):
                    return int(result & ((1 << 32) - 1))
                shift += 7

        # 1. Dynamically parse ALL index.tfi files to build the master dictionary on the fly
        for d in valid_dirs:
            dir_path = game_path / d
            if not dir_path.exists():
                continue
                
            for tfi_path in dir_path.rglob("index.tfi"):
                # Get the relative path of this specific index.tfi from the game root (e.g. ui/managed)
                tfi_rel_dir = tfi_path.parent.relative_to(game_path)
                
                try:
                    reader = BinaryReader(tfi_path.read_bytes())
                    while reader.pos() < reader.size():
                        name_len = _local_read_leb128(reader)
                        internal_path = reader.read_str(name_len)
                        _ = _local_read_leb128(reader) # archive
                        _ = _local_read_leb128(reader) # offset
                        _ = _local_read_leb128(reader) # size
                        _ = _local_read_leb128(reader) # hash
                        
                        # Combine the relative TFI directory with the file's internal path
                        full_rel_path = (tfi_rel_dir / internal_path).as_posix()
                            
                        filename = Path(full_rel_path).name.lower()
                        # Prevents edge case overwrites if two files share a name
                        if filename not in file_map:
                            file_map[filename] = full_rel_path
                except Exception as e:
                    print(f"Failed to parse {tfi_path}: {e}")
                    continue

        # 2. Scan valid directories in the workspace for loose files to move
        moved_files = []
        ignored_extensions = {'.tfi', '.tfa', '.exe', '.dll', '.tmod', '.zip', '.cfg', '.txt', '.log', '.ini', '.toml', '.json', '.xml', '.dat'}
        
        for d in valid_dirs:
            target_dir = workspace / d
            if not target_dir.exists():
                continue
                
            for file_path in target_dir.rglob("*"):
                # Ignore non-files and specifically blocked extensions
                if not file_path.is_file() or file_path.suffix.lower() in ignored_extensions:
                    continue
                    
                # Skip if the file is already inside an 'override' folder anywhere in its path
                if 'override' in [p.lower() for p in file_path.parts]:
                    continue
                    
                filename = file_path.name.lower()
                
                # If we found a match in the dynamically built game dictionary
                if filename in file_map:
                    expected_full = file_map[filename]
                    parts = expected_full.split('/')
                    # Inject the override directory just before the filename
                    parts.insert(-1, "override")
                    new_rel_path = "/".join(parts)
                    
                    new_path = workspace / new_rel_path
                    
                    # Move it to the proper override location
                    if file_path.resolve() != new_path.resolve():
                        new_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(file_path), str(new_path))
                        moved_files.append({"old": str(file_path), "new": str(new_path)})
                            
        return {"success": True, "count": len(moved_files)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def get_missing_files(paths):
    try:
        missing = []
        for p in paths:
            if not Path(p).exists() or not Path(p).is_file():
                missing.append(p)
        return {"success": True, "missing": missing}
    except Exception as e:
        return {"success": False, "error": str(e)}

@eel.expose
def build_tmod(payload):
    try:
        game_path_str = payload.get("gamePath")
        if not game_path_str:
            return {"success": False, "error": "No game installation selected."}
            
        game_path = Path(game_path_str)
        if not game_path.exists():
            return {"success": False, "error": "Selected game installation path does not exist."}
            
        mod = TMod()
        
        title = payload.get("title", "").strip()
        if not title:
            return {"success": False, "error": "Mod title is required."}

        if re.search(r'[<>:"/\\|?*]', title):
            return {"success": False, "error": "Mod title contains illegal characters (< > : \" / \\ | ? *)."}

        author = payload.get("author", "").strip()
        version = payload.get("version", "").strip()
        notes = payload.get("notes", "").strip()
        tags = payload.get("tags", [])
        files = payload.get("files", [])
        
        if not author: return {"success": False, "error": "Mod author is required."}
        if not version: return {"success": False, "error": "Mod version is required."}
        if not notes: return {"success": False, "error": "Mod notes are required."}
        if not tags: return {"success": False, "error": "At least one tag is required."}
        if not files: return {"success": False, "error": "At least one file is required."}

        out_dir = game_path / "mods"
        save_path = out_dir / f"{title}.tmod"
        
        if save_path.exists():
            return {"success": False, "error": f"A mod file named '{title}.tmod' already exists in the mods folder. Please choose a different title or remove the existing file."}

        mod.name = title
        mod.author = author
        mod.add_property("modVersion", version)
        mod.notes = notes
            
        for tag in tags:
            mod.add_tag(tag)

        mod.add_property("compileDate", str(int(datetime.now(UTC).timestamp())))
            
        preview_b64 = payload.get("previewBase64")
        preview_name = payload.get("previewName", "preview.png")

        if preview_b64 and "," in preview_b64:
            header, data_str = preview_b64.split(",", 1)
            img_bytes = base64.b64decode(data_str)
            clean_name = re.sub(r'[\\/*?:"<>|]', "", preview_name)
            preview_path = Path(f"ui/{clean_name}")
            mod.add_file(TroveModFile(preview_path, img_bytes))
            mod.preview_path = preview_path
            
        for f in files:
            abs_path = f.get("abs_path")
            internal_path_str = f.get("internal_path", f.get("name", "unknown_file"))
            f_path = Path(internal_path_str)
            
            if abs_path and Path(abs_path).exists():
                f_bytes = Path(abs_path).read_bytes()
                mod.add_file(TroveModFile(f_path, f_bytes))
            else:
                b64_data = f.get("data")
                if b64_data and "," in b64_data:
                    _, data_str = b64_data.split(",", 1)
                    f_bytes = base64.b64decode(data_str)
                    mod.add_file(TroveModFile(f_path, f_bytes))
            
        out_dir.mkdir(parents=True, exist_ok=True)
        mod.mod_path = save_path
        
        tmod_bytes = mod.compile_tmod()
        save_path.write_bytes(tmod_bytes)
        
        return {"success": True, "path": str(save_path)}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}