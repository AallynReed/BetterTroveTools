import base64
import os
import re
import json
import shutil
import uuid
import tkinter as tk
from datetime import UTC, datetime
from pathlib import Path
from tkinter import filedialog

import eel

from backend.qubicle_qb import QubicleDocument
from backend.trove_blueprint import BlueprintDecodeError, blueprint_to_document, blueprint_to_package
from backend.response import standardize_response
from binary_reader import BinaryReader

from models.trove.directory import Directories
from models.trove.mod import TMod, TroveModFile


class OperationCancelled(Exception):
    pass


_MODDER_CANCEL_FLAGS = {
    "extract_tmod": False,
    "detect_overrides": False,
    "auto_structure_workspace": False,
    "build_tmod": False,
    "auto_structure_project": False,
    "place_overrides": False,
    "remove_overrides": False,
    "compile_project": False,
}


def _decode_data_url(data_url):
    if not data_url or "," not in data_url:
        return None
    _, data_str = data_url.split(",", 1)
    return base64.b64decode(data_str)


def _normalize_internal_path(path) -> str | None:
    if path is None:
        return None
    normalized = Path(path).as_posix().strip().lower()
    return normalized or None


def _default_config_path() -> Path:
    return Path("ui/default.cfg")


def _validate_special_paths(file_paths, preview_path=None, include_config=False):
    normalized_files = []
    seen_files = set()
    for path in file_paths or []:
        normalized = _normalize_internal_path(path)
        if not normalized:
            continue
        if normalized in seen_files:
            return "You cannot add the same file path more than once."
        seen_files.add(normalized)
        normalized_files.append(normalized)

    preview_normalized = _normalize_internal_path(preview_path)
    if preview_normalized and preview_normalized in seen_files:
        return "Preview image path cannot also be included in the files list."

    default_cfg = _default_config_path().as_posix()
    cfg_paths = [path for path in normalized_files if path.endswith(".cfg")]
    if include_config:
        cfg_paths.append(default_cfg)
        if default_cfg in seen_files:
            return "default.cfg can only be added through the config file option."

    if not cfg_paths:
        return None
    if len(cfg_paths) > 1:
        return "Only one config file can be included in a mod."
    if cfg_paths[0] != default_cfg:
        return "default.cfg can only be added through the config file option."
    return None


def _trash_root():
    appdata = os.getenv("APPDATA")
    base = Path(appdata) if appdata else Path.cwd()
    root = base / "Trove" / "ModderToolsTrash"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _undo_manifest_path():
    return _trash_root() / "undo_remove_overrides.json"


def _read_undo_manifest():
    path = _undo_manifest_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_undo_manifest(data):
    _undo_manifest_path().write_text(json.dumps(data, indent=2), encoding="utf-8")


def _reset_cancel_flag(operation):
    if operation in _MODDER_CANCEL_FLAGS:
        _MODDER_CANCEL_FLAGS[operation] = False


def _is_cancelled(operation):
    return bool(_MODDER_CANCEL_FLAGS.get(operation, False))


def _raise_if_cancelled(operation):
    if _is_cancelled(operation):
        raise OperationCancelled("Operation cancelled by user.")


@eel.expose
@standardize_response
def cancel_modder_tools_operation(operation):
    op = str(operation or "")
    if op not in _MODDER_CANCEL_FLAGS:
        return {"success": False, "error": "Unknown operation."}
    _MODDER_CANCEL_FLAGS[op] = True
    return {"success": True}


@eel.expose
@standardize_response
def ask_mod_source_directory():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Mod Source Folder")
    root.destroy()
    return folder_path

@eel.expose
@standardize_response
def ask_tmod_file():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.askopenfilename(title="Select TMod File", filetypes=[("Trove Mods", "*.tmod")])
    root.destroy()
    return file_path


@eel.expose
@standardize_response
def ask_qb_file():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.askopenfilename(
        title="Select QB or Trove Blueprint File",
        filetypes=[
            ("Voxel Files", "*.qb;*.blueprint"),
            ("Qubicle Binary", "*.qb"),
            ("Trove Blueprint", "*.blueprint"),
            ("All Files", "*.*"),
        ],
    )
    root.destroy()
    return file_path


@eel.expose
@standardize_response
def ask_qb_save_file(current_path_str=None, suggested_name="untitled.qb"):
    current_path = Path(str(current_path_str or "").strip()) if current_path_str else None
    initial_dir = str(current_path.parent) if current_path and current_path.parent.exists() else None
    initial_name = current_path.name if current_path and current_path.name else str(suggested_name or "untitled.qb")
    if not initial_name.lower().endswith(".qb"):
        initial_name = f"{initial_name}.qb"

    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.asksaveasfilename(
        title="Save Qubicle QB File",
        initialdir=initial_dir,
        initialfile=initial_name,
        defaultextension=".qb",
        filetypes=[("Qubicle Binary", "*.qb"), ("All Files", "*.*")],
    )
    root.destroy()
    return file_path

@eel.expose
@standardize_response
def ask_extract_destination():
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    folder_path = filedialog.askdirectory(title="Select Extraction Destination")
    root.destroy()
    return folder_path


@eel.expose
@standardize_response
def load_qb_file(path_str):
    path = Path(str(path_str or "").strip())
    if not path.exists() or not path.is_file():
        return {"success": False, "error": "QB file does not exist."}

    if path.suffix.lower() == ".blueprint":
        try:
            package = blueprint_to_package(path)
        except BlueprintDecodeError as exc:
            raw_data = path.read_bytes()
            try:
                document = blueprint_to_document(raw_data, path.name)
            except BlueprintDecodeError:
                return {"success": False, "error": str(exc)}
            document["path"] = str(path)
            document["file_name"] = path.name
            return {"success": True, "document": document}
        selected_asset = package["assets"][package["selected_asset_id"]]
        return {"success": True, "document": selected_asset, "package": package}
    else:
        raw_data = path.read_bytes()
        document = QubicleDocument.from_bytes(raw_data).to_dict()
    document["path"] = str(path)
    document["file_name"] = path.name
    return {"success": True, "document": document}


@eel.expose
@standardize_response
def save_qb_file(path_str, payload):
    raw_path = str(path_str or "").strip()
    if not raw_path:
        return {"success": False, "error": "No QB output path was provided."}

    path = Path(raw_path)
    if path.suffix.lower() != ".qb":
        path = path.with_suffix(".qb")

    document = QubicleDocument.from_dict(payload).to_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(document)

    return {"success": True, "path": str(path), "file_name": path.name}


@eel.expose
@standardize_response
def ask_preview_file(game_path_str=None):
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.askopenfilename(
        title="Select Preview Image",
        initialdir=game_path_str or None,
        filetypes=[("Images", "*.png;*.jpg;*.jpeg"), ("PNG", "*.png"), ("JPEG", "*.jpg;*.jpeg")],
    )
    root.destroy()
    if not file_path:
        return {"success": True, "file": None}
    path = Path(file_path)
    return {
        "success": True,
        "file": {
            "name": path.name,
            "path": str(path),
            "data": f"data:image/{'png' if path.suffix.lower() == '.png' else 'jpeg'};base64,"
            + base64.b64encode(path.read_bytes()).decode("utf-8"),
        },
    }


@eel.expose
@standardize_response
def ask_config_file(game_path_str=None):
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.askopenfilename(
        title="Select Config File",
        initialdir=game_path_str or None,
        filetypes=[("Config Files", "*.cfg")],
    )
    root.destroy()
    if not file_path:
        return {"success": True, "file": None}
    path = Path(file_path)
    return {
        "success": True,
        "file": {
            "name": path.name,
            "path": str(path),
            "data": "data:text/plain;base64," + base64.b64encode(path.read_bytes()).decode("utf-8"),
        },
    }

@eel.expose
@standardize_response
def ask_add_files(game_path_str=None):
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_paths = filedialog.askopenfilenames(title="Select Files to Add", initialdir=game_path_str or None)
    root.destroy()
    
    files = []
    rejected = []
    rejected_cfg = []
    if not file_paths:
        return {"success": True, "files": files, "rejected": rejected, "rejected_cfg": rejected_cfg}
        
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
            elif file_path.suffix.lower() == ".cfg":
                rejected_cfg.append(file_path.name)
            else:
                internal_path = "/".join(internal_parts)
                files.append({
                    "path": str(file_path),
                    "internal_path": internal_path
                })
            
    return {"success": True, "files": files, "rejected": rejected, "rejected_cfg": rejected_cfg}

@eel.expose
@standardize_response
def extract_tmod(tmod_path_str, dest_path_str):
    try:
        _reset_cancel_flag("extract_tmod")
        tmod_path = Path(tmod_path_str)
        dest_path = Path(dest_path_str)
        
        if not tmod_path.exists() or not tmod_path.is_file():
            return {"success": False, "error": "TMod file does not exist."}
            
        dest_path.mkdir(parents=True, exist_ok=True)
        
        file_data = tmod_path.read_bytes()
        mod = TMod.read_bytes(tmod_path, file_data)
        
        extracted_count = 0
        for file in mod.files:
            _raise_if_cancelled("extract_tmod")
            out_path = dest_path / Path(file.trove_path.replace("\\", "/"))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            
            out_path.write_bytes(file.data)
            extracted_count += 1
            
        return {"success": True, "count": extracted_count}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def detect_override_files(source_dir_str):
    try:
        _reset_cancel_flag("detect_overrides")
        source_dir = Path(source_dir_str)
        if not source_dir.exists() or not source_dir.is_dir():
            return {"success": False, "error": "Invalid source directory."}
            
        valid_dirs = [d.value.lower() for d in Directories]
        files = []
        
        for file_path in source_dir.rglob("*"):
            _raise_if_cancelled("detect_overrides")
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
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def auto_structure_workspace(workspace_dir_str, game_path_str):
    try:
        _reset_cancel_flag("auto_structure_workspace")
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

        for d in valid_dirs:
            _raise_if_cancelled("auto_structure_workspace")
            dir_path = game_path / d
            if not dir_path.exists():
                continue
                
            for tfi_path in dir_path.rglob("index.tfi"):
                _raise_if_cancelled("auto_structure_workspace")
                tfi_rel_dir = tfi_path.parent.relative_to(game_path)
                
                try:
                    reader = BinaryReader(tfi_path.read_bytes())
                    while reader.pos() < reader.size():
                        name_len = _local_read_leb128(reader)
                        internal_path = reader.read_str(name_len)
                        _ = _local_read_leb128(reader)
                        _ = _local_read_leb128(reader)
                        _ = _local_read_leb128(reader)
                        _ = _local_read_leb128(reader)
                        
                        full_rel_path = (tfi_rel_dir / internal_path).as_posix()
                            
                        filename = Path(full_rel_path).name.lower()
                        if filename not in file_map:
                            file_map[filename] = full_rel_path
                except Exception as e:
                    print(f"Failed to parse {tfi_path}: {e}")
                    continue

        moved_files = []
        ignored_extensions = {'.tfi', '.tfa', '.exe', '.dll', '.tmod', '.zip', '.cfg', '.txt', '.log', '.ini', '.toml', '.json', '.xml', '.dat'}
        
        for d in valid_dirs:
            _raise_if_cancelled("auto_structure_workspace")
            target_dir = workspace / d
            if not target_dir.exists():
                continue
                
            for file_path in target_dir.rglob("*"):
                _raise_if_cancelled("auto_structure_workspace")
                if not file_path.is_file() or file_path.suffix.lower() in ignored_extensions:
                    continue
                    
                if 'override' in [p.lower() for p in file_path.parts]:
                    continue
                    
                filename = file_path.name.lower()
                
                if filename in file_map:
                    expected_full = file_map[filename]
                    parts = expected_full.split('/')
                    parts.insert(-1, "override")
                    new_rel_path = "/".join(parts)
                    
                    new_path = workspace / new_rel_path
                    
                    if file_path.resolve() != new_path.resolve():
                        new_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(file_path), str(new_path))
                        moved_files.append({"old": str(file_path), "new": str(new_path)})
                            
        return {"success": True, "count": len(moved_files)}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
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
@standardize_response
def build_tmod(payload):
    try:
        _reset_cancel_flag("build_tmod")
        game_path_str = payload.get("gamePath")
        if not game_path_str:
            return {"success": False, "error": "No game installation selected."}
            
        game_path = Path(game_path_str)
        if not game_path.exists():
            return {"success": False, "error": "Selected game installation path does not exist."}
            
        mod = TMod()
        
        title = payload.get("title", "").strip()
        if title.lower().endswith(".tmod"):
            title = title[:-5].strip()
        if not title:
            return {"success": False, "error": "Mod title is required."}

        if re.search(r'[<>:"/\\|?*]', title):
            return {"success": False, "error": "Mod title contains illegal characters (< > : \" / \\ | ? *)."}

        author = payload.get("author", "").strip()
        version = payload.get("version", "").strip()
        notes = payload.get("notes", "").strip()
        if len(notes) > 220:
            return {"success": False, "error": "Mod notes cannot exceed 220 characters."}
        tags = payload.get("tags", [])
        files = payload.get("files", [])
        
        if not author: return {"success": False, "error": "Mod author is required."}
        if not version: return {"success": False, "error": "Mod version is required."}
        if not notes: return {"success": False, "error": "Mod notes are required."}
        if not tags: return {"success": False, "error": "At least one tag is required."}
        if not files: return {"success": False, "error": "At least one file is required."}

        config_data = _decode_data_url(payload.get("configBase64"))
        config_path = _default_config_path() if config_data is not None else None

        preview_name = payload.get("previewName", "preview.png")
        clean_preview_name = re.sub(r'[\\/*?:"<>|]', "", preview_name)
        preview_path = Path(f"ui/{clean_preview_name}") if payload.get("previewBase64") else None

        path_error = _validate_special_paths(
            [f.get("internal_path", f.get("name", "unknown_file")) for f in files],
            preview_path=preview_path.as_posix() if preview_path else None,
            include_config=config_data is not None,
        )
        if path_error:
            return {"success": False, "error": path_error}

        out_dir = game_path / "mods"
        save_path = out_dir / f"{title}.tmod"
        
        overwrite = bool(payload.get("overwrite", False))
        if save_path.exists() and not overwrite:
            return {
                "success": False,
                "code": "FILE_EXISTS",
                "error": f"A mod file named '{title}.tmod' already exists in the mods folder.",
                "path": str(save_path),
            }

        mod.name = title
        mod.author = author
        mod.add_property("modVersion", version)
        mod.notes = notes
            
        for tag in tags:
            mod.add_tag(tag)

        mod.add_property("compileDate", str(int(datetime.now(UTC).timestamp())))
            
        preview_b64 = payload.get("previewBase64")

        preview_bytes = _decode_data_url(preview_b64)
        if preview_bytes is not None and preview_path is not None:
            mod.add_file(TroveModFile(preview_path, preview_bytes))
            mod.preview_path = preview_path

        if config_data is not None and config_path is not None:
            mod.add_file(TroveModFile(config_path, config_data))
            mod.config_path = config_path

        for f in files:
            _raise_if_cancelled("build_tmod")
            abs_path = f.get("abs_path")
            internal_path_str = f.get("internal_path", f.get("name", "unknown_file"))
            f_path = Path(internal_path_str)
            
            if abs_path and Path(abs_path).exists():
                f_bytes = Path(abs_path).read_bytes()
                mod.add_file(TroveModFile(f_path, f_bytes))
            else:
                b64_data = f.get("data")
                f_bytes = _decode_data_url(b64_data)
                if f_bytes is not None:
                    mod.add_file(TroveModFile(f_path, f_bytes))

        out_dir.mkdir(parents=True, exist_ok=True)
        if save_path.exists() and overwrite:
            save_path.unlink(missing_ok=True)
        mod.mod_path = save_path
        
        tmod_bytes = mod.compile_tmod()
        save_path.write_bytes(tmod_bytes)
        
        return {"success": True, "path": str(save_path)}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def load_mod_project(project_path_str):
    try:
        project_path = Path(project_path_str)
        if not project_path.exists() or not project_path.is_dir():
            return {"success": False, "error": "Invalid project directory."}

        project_file = project_path / "project.json"
        
        versions = []
        for item in project_path.iterdir():
            if item.is_dir() and item.name.startswith("v"):
                versions.append(item.name.lstrip("v"))
        
        if not versions:
            versions = ["1.0"]
            (project_path / "v1.0").mkdir(exist_ok=True)

        if project_file.exists():
            data = json.loads(project_file.read_text(encoding="utf-8"))
            data.setdefault("configBase64", None)
            data.setdefault("configName", "")
            data["versions"] = sorted(list(set(versions + data.get("versions", []))))
            return {"success": True, "data": data}
        else:
            default_data = {
                "title": project_path.name,
                "author": "",
                "notes": "",
                "tags": [],
                "versions": versions,
                "active_version": versions[0],
                "configBase64": None,
                "configName": "",
            }
            project_file.write_text(json.dumps(default_data, indent=4), encoding="utf-8")
            return {"success": True, "data": default_data}

    except Exception as e:
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def save_mod_project(project_path_str, payload):
    try:
        if len(payload.get("notes", "")) > 220:
            return {"success": False, "error": "Mod notes cannot exceed 220 characters."}
        project_path = Path(project_path_str)
        project_file = project_path / "project.json"
        
        if project_file.exists():
            data = json.loads(project_file.read_text(encoding="utf-8"))
            data.update(payload)
        else:
            data = payload
            
        project_file.write_text(json.dumps(data, indent=4), encoding="utf-8")
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def create_project_version(project_path_str, new_version):
    try:
        project_path = Path(project_path_str)
        version_folder = project_path / f"v{new_version}"
        
        if version_folder.exists():
            return {"success": False, "error": "Version folder already exists."}
            
        version_folder.mkdir(parents=True, exist_ok=True)
        
        project_file = project_path / "project.json"
        if project_file.exists():
            data = json.loads(project_file.read_text(encoding="utf-8"))
            if new_version not in data.get("versions", []):
                versions = data.get("versions", [])
                versions.append(new_version)
                data["versions"] = sorted(versions)
                data["active_version"] = new_version
                project_file.write_text(json.dumps(data, indent=4), encoding="utf-8")

        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}
    
@eel.expose
@standardize_response
def get_project_files(project_path_str, version):
    try:
        target_dir = Path(project_path_str) / f"v{version}"
        if not target_dir.exists():
            return {"success": True, "files": []}
            
        files = []
        for file_path in target_dir.rglob("*"):
            if file_path.is_file():
                if any(part.startswith("__") for part in file_path.relative_to(target_dir).parts):
                    continue
                    
                rel_path = file_path.relative_to(target_dir).as_posix()
                files.append({
                    "name": file_path.name,
                    "rel_path": rel_path,
                    "abs_path": str(file_path)
                })
                
        files.sort(key=lambda x: x["rel_path"])
        return {"success": True, "files": files}
    except Exception as e:
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def auto_structure_project_version(project_path_str, version, game_path_str):
    try:
        _reset_cancel_flag("auto_structure_project")
        game_path = Path(game_path_str)
        target_dir = Path(project_path_str) / f"v{version}"
        
        if not game_path.exists() or not target_dir.exists():
            return {"success": False, "error": "Invalid game path or version directory."}
            
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

        for d in valid_dirs:
            _raise_if_cancelled("auto_structure_project")
            dir_path = game_path / d
            if not dir_path.exists(): continue
                
            for tfi_path in dir_path.rglob("index.tfi"):
                _raise_if_cancelled("auto_structure_project")
                tfi_rel_dir = tfi_path.parent.relative_to(game_path)
                try:
                    reader = BinaryReader(tfi_path.read_bytes())
                    while reader.pos() < reader.size():
                        name_len = _local_read_leb128(reader)
                        internal_path = reader.read_str(name_len)
                        _ = _local_read_leb128(reader)
                        _ = _local_read_leb128(reader)
                        _ = _local_read_leb128(reader)
                        _ = _local_read_leb128(reader)
                        
                        full_rel_path = (tfi_rel_dir / internal_path).as_posix()
                        filename = Path(full_rel_path).name.lower()
                        if filename not in file_map:
                            file_map[filename] = full_rel_path
                except Exception:
                    continue

        moved_files = []
        ignored_extensions = {'.tfi', '.tfa', '.exe', '.dll', '.tmod', '.zip', '.cfg', '.txt', '.log', '.ini', '.toml', '.json', '.xml', '.dat'}
        
        for file_path in list(target_dir.rglob("*")):
            _raise_if_cancelled("auto_structure_project")
            if not file_path.is_file() or file_path.suffix.lower() in ignored_extensions:
                continue
            if any(part.startswith("__") for part in file_path.relative_to(target_dir).parts):
                continue
                
            filename = file_path.name.lower()
            
            if filename in file_map:
                expected_full = file_map[filename]
                new_path = target_dir / expected_full
                
                if file_path.resolve() != new_path.resolve():
                    new_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(file_path), str(new_path))
                    moved_files.append({"old": str(file_path), "new": str(new_path)})
                        
        return {"success": True, "count": len(moved_files)}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
    
@eel.expose
@standardize_response
def place_project_overrides(project_path_str, version, game_path_str):
    try:
        _reset_cancel_flag("place_overrides")
        game_path = Path(game_path_str)
        target_dir = Path(project_path_str) / f"v{version}"
        
        if not game_path.exists() or not target_dir.exists():
            return {"success": False, "error": "Invalid game path or version directory."}
            
        placed_files = []
        
        for file_path in target_dir.rglob("*"):
            _raise_if_cancelled("place_overrides")
            if file_path.is_file():
                if any(part.startswith("__") for part in file_path.relative_to(target_dir).parts):
                    continue
                    
                rel_path = file_path.relative_to(target_dir)
                
                parts = list(rel_path.parts)
                parts.insert(-1, "override")
                game_override_path = game_path.joinpath(*parts)
                
                game_override_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(file_path), str(game_override_path))
                placed_files.append(str(game_override_path))
                
        return {"success": True, "placed_files": placed_files, "count": len(placed_files)}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
@standardize_response
def remove_project_overrides(placed_files):
    try:
        _reset_cancel_flag("remove_overrides")
        removed_count = 0
        moved_files = []
        undo_token = uuid.uuid4().hex
        backup_dir = _trash_root() / undo_token
        backup_dir.mkdir(parents=True, exist_ok=True)

        for file_str in placed_files:
            if _is_cancelled("remove_overrides"):
                break
            file_path = Path(file_str)
            if file_path.exists() and file_path.is_file():
                backup_path = backup_dir / f"{removed_count}_{file_path.name}"
                shutil.move(str(file_path), str(backup_path))
                moved_files.append({"original": str(file_path), "backup": str(backup_path)})
                removed_count += 1
                
                try:
                    if not any(file_path.parent.iterdir()):
                        file_path.parent.rmdir()
                except Exception:
                    pass

        manifest = _read_undo_manifest()
        if moved_files:
            manifest[undo_token] = {
                "created_at": datetime.now(UTC).isoformat(),
                "files": moved_files,
            }
            _write_undo_manifest(manifest)

        if _is_cancelled("remove_overrides"):
            return {
                "success": False,
                "cancelled": True,
                "error": "Operation cancelled by user.",
                "count": removed_count,
                "undo_token": undo_token if moved_files else None,
            }

        return {"success": True, "count": removed_count, "undo_token": undo_token if moved_files else None}
    except Exception as e:
        return {"success": False, "error": str(e)}


@eel.expose
@standardize_response
def undo_remove_project_overrides(undo_token):
    try:
        token = str(undo_token or "").strip()
        if not token:
            return {"success": False, "error": "Missing undo token."}

        manifest = _read_undo_manifest()
        entry = manifest.get(token)
        if not entry:
            return {"success": False, "error": "Undo token not found or expired."}

        restored = 0
        conflicts = []

        for item in entry.get("files", []):
            original = Path(item.get("original", ""))
            backup = Path(item.get("backup", ""))
            if not backup.exists() or not backup.is_file():
                continue
            if original.exists():
                conflicts.append(str(original))
                continue

            original.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(backup), str(original))
            restored += 1

        token_dir = _trash_root() / token
        if token_dir.exists():
            try:
                shutil.rmtree(token_dir)
            except Exception:
                pass

        manifest.pop(token, None)
        _write_undo_manifest(manifest)

        return {"success": True, "restored": restored, "conflicts": conflicts}
    except Exception as e:
        return {"success": False, "error": str(e)}
    
@eel.expose
@standardize_response
def compile_project(project_path_str, version, game_path_str):
    try:
        _reset_cancel_flag("compile_project")
        project_path = Path(project_path_str)
        game_path = Path(game_path_str)
        target_dir = project_path / f"v{version}"
        project_file = project_path / "project.json"

        if not game_path.exists() or not target_dir.exists() or not project_file.exists():
            return {"success": False, "error": "Invalid paths or missing project.json. Please save the project first."}

        meta = json.loads(project_file.read_text(encoding="utf-8"))
        notes = meta.get("notes", "").strip()
        if len(notes) > 220:
            return {"success": False, "error": "Mod notes cannot exceed 220 characters. Please edit the notes and try again."}

        title = meta.get("title", "Untitled Project").strip()
        if title.lower().endswith(".tmod"):
            title = title[:-5].strip()
        author = meta.get("author", "Unknown").strip()
        notes = meta.get("notes", "").strip()
        tags = meta.get("tags", [])

        if not title:
            return {"success": False, "error": "Project title cannot be empty."}
        if re.search(r'[<>:"/\\|?*]', title):
            return {"success": False, "error": "Project title contains illegal characters."}

        mod = TMod()
        mod.name = title
        mod.author = author
        mod.add_property("modVersion", version.strip())
        mod.notes = notes
        for tag in tags:
            mod.add_tag(tag)
        
        mod.add_property("compileDate", str(int(datetime.now(UTC).timestamp())))

        preview_b64 = meta.get("previewBase64")
        preview_name = meta.get("previewName", "preview.png")
        clean_preview_name = re.sub(r'[\\/*?:"<>|]', "", preview_name)
        preview_path = Path(f"ui/{clean_preview_name}") if preview_b64 else None
        config_data = _decode_data_url(meta.get("configBase64"))
        config_path = _default_config_path() if config_data is not None else None
        path_error = _validate_special_paths(
            [file_path.relative_to(target_dir).as_posix() for file_path in target_dir.rglob("*") if file_path.is_file()],
            preview_path=preview_path.as_posix() if preview_path else None,
            include_config=config_data is not None,
        )
        if path_error:
            return {"success": False, "error": path_error}

        preview_bytes = _decode_data_url(preview_b64)
        if preview_bytes is not None and preview_path is not None:
            mod.add_file(TroveModFile(preview_path, preview_bytes))
            mod.preview_path = preview_path

        if config_data is not None and config_path is not None:
            mod.add_file(TroveModFile(config_path, config_data))
            mod.config_path = config_path

        file_count = 0
        ignored_extensions = {'.tfi', '.tfa', '.exe', '.dll', '.tmod', '.zip', '.cfg', '.txt', '.log', '.ini', '.toml', '.json', '.xml', '.dat'}
        
        for file_path in target_dir.rglob("*"):
            _raise_if_cancelled("compile_project")
            if file_path.is_file() and file_path.suffix.lower() not in ignored_extensions:
                if any(part.startswith("__") for part in file_path.relative_to(target_dir).parts):
                    continue
                
                rel_path = file_path.relative_to(target_dir)
                f_bytes = file_path.read_bytes()
                mod.add_file(TroveModFile(Path(rel_path.as_posix()), f_bytes))
                file_count += 1

        if file_count == 0:
            return {"success": False, "error": f"No valid game files found in the v{version} folder."}

        out_dir = game_path / "mods"
        out_dir.mkdir(parents=True, exist_ok=True)
        
        save_path = out_dir / f"{title}.tmod"
        
        if save_path.exists():
            save_path.unlink(missing_ok=True)

        mod.mod_path = save_path
        tmod_bytes = mod.compile_tmod()
        save_path.write_bytes(tmod_bytes)

        return {"success": True, "path": str(save_path)}
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}
