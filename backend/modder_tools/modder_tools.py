import base64
import os
import re
import json
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

try:
    import tkinter as tk
    from tkinter import filedialog
except Exception:  # python3-tk not installed (common on minimal Linux setups)
    tk = None
    filedialog = None

import eel

from utils.blueprint.qubicle_qb import QubicleDocument
from utils.blueprint.trove_blueprint import (
    BlueprintDecodeError,
    blueprint_render_document,
    blueprint_to_document,
    blueprint_to_package,
    document_to_blueprint,
    export_blueprint_render as _bp_export_render,
    recompile_blueprint_package,
)
from utils.blueprint.trove_block_mapping import load_block_mapping, load_full_block_catalogue
from backend.response import standardize_response
from binary_reader import BinaryReader

from models.trove.directory import Directories
from models.trove.mod import TMod, TroveModFile
from utils.path import get_app_data_dir


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

_KNOWN_MOD_SUBTYPES = {
    "Bard",
    "Boomeranger",
    "Candy Barbarian",
    "Chloromancer",
    "Dino Tamer",
    "Dracolyte",
    "Fae Trickster",
    "Gunslinger",
    "Ice Sage",
    "Knight",
    "Lunar Lancer",
    "Neon Ninja",
    "Pirate Captain",
    "Revenant",
    "Shadow Hunter",
    "Solarion",
    "Tomb Raiser",
    "Vanguardian",
}


def _decode_data_url(data_url):
    if not data_url or "," not in data_url:
        return None
    _, data_str = data_url.split(",", 1)
    return base64.b64decode(data_str)


def _encode_data_url(data: bytes, mime_type: str = "application/octet-stream"):
    return f"data:{mime_type};base64,{base64.b64encode(data).decode('utf-8')}"


def _normalize_internal_path(path) -> str | None:
    if path is None:
        return None
    normalized = Path(path).as_posix().strip().lower()
    return normalized or None


def _config_internal_path(title) -> Path:
    """Where a mod's config file lives inside the .tmod: `ui/<title>.cfg`.

    Named after the mod rather than a shared `ui/default.cfg` because these land
    in the game's single `ui/` directory — every mod using the old fixed name
    fought over the same file. Reading is unaffected either way: the path is
    recorded per-mod in the `configPath` header property, so mods built before
    this still resolve their own config.
    """
    clean_title = re.sub(r'[\\/*?:"<>|]', "", str(title or "")).strip()
    return Path(f"ui/{clean_title}.cfg")


PREVIEW_EXTENSIONS = (".png", ".jpg", ".jpeg")


def _preview_internal_path(title, source_name=None) -> Path:
    """Where a mod's preview image lives inside the .tmod: `ui/<title>.<ext>`.

    Same reasoning as _config_internal_path: previews land in the game's single
    `ui/` directory, so keeping the picked file's own name meant two mods could
    both ship `ui/preview.png` and clobber each other. Only the extension comes
    from the picked file, which also discards Windows' doubled `.png.png` names.
    """
    clean_title = re.sub(r'[\\/*?:"<>|]', "", str(title or "")).strip()
    extension = Path(str(source_name or "")).suffix.lower()
    if extension not in PREVIEW_EXTENSIONS:
        extension = ".png"
    return Path(f"ui/{clean_title}{extension}")


def _validate_special_paths(file_paths, preview_path=None, include_config=False, title=None):
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

    # Derived from the title whether or not the config option was used, so a cfg
    # hand-added at the mod's own path still validates (as ui/default.cfg did
    # before the rename) instead of being rejected outright.
    mod_cfg = _normalize_internal_path(_config_internal_path(title).as_posix())
    cfg_paths = [path for path in normalized_files if path.endswith(".cfg")]
    if include_config:
        cfg_paths.append(mod_cfg)
        if mod_cfg in seen_files:
            return "The config file can only be added through the config file option."

    if not cfg_paths:
        return None
    if len(cfg_paths) > 1:
        return "Only one config file can be included in a mod."
    if cfg_paths[0] != mod_cfg:
        return "The config file can only be added through the config file option."
    return None


def _trash_root():
    root = get_app_data_dir() / "ModderToolsTrash"
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


def _split_type_and_subtype(tags, explicit_subtype=""):
    clean_tags = []
    found_subtype = str(explicit_subtype or "").strip()
    for tag in tags or []:
        clean_tag = str(tag or "").strip()
        if not clean_tag:
            continue
        if not found_subtype and clean_tag in _KNOWN_MOD_SUBTYPES:
            found_subtype = clean_tag
            continue
        clean_tags.append(clean_tag)
    return clean_tags, found_subtype


def _combine_tags_with_subtype(tags, subtype=""):
    clean_tags, _ = _split_type_and_subtype(tags, "")
    clean_subtype = str(subtype or "").strip()
    if clean_subtype:
        clean_tags.append(clean_subtype)
    return clean_tags


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
def ask_import_file(game_path_str=None):
    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.askopenfilename(
        title="Select File",
        initialdir=game_path_str or None,
        filetypes=[("All Files", "*.*")],
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
            "data": _encode_data_url(path.read_bytes()),
        },
    }


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
    if not initial_name.lower().endswith((".qb", ".blueprint")):
        initial_name = f"{initial_name}.qb"

    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    file_path = filedialog.asksaveasfilename(
        title="Save Voxel File",
        initialdir=initial_dir,
        initialfile=initial_name,
        defaultextension=".qb",
        filetypes=[
            ("Qubicle Binary", "*.qb"),
            ("Trove Blueprint", "*.blueprint"),
            ("All Files", "*.*"),
        ],
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
def load_qb_file(path_str, game_path_str=None):
    path = Path(str(path_str or "").strip())
    if not path.exists() or not path.is_file():
        return {"success": False, "error": "QB file does not exist."}

    if path.suffix.lower() == ".blueprint":
        try:
            # game_path (when known) enables exact procedural tints + block names.
            package = blueprint_to_package(path, game_path=game_path_str or None)
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
        return {"success": False, "error": "No output path was provided."}

    path = Path(raw_path)

    if path.suffix.lower() == ".blueprint":
        # Native Trove blueprint save (no QB round-trip needed).
        try:
            if isinstance(payload, dict) and payload.get("assets"):
                # Multi-layer package: recombine base + type/alpha/specular maps.
                data = recompile_blueprint_package(payload)
            else:
                data = document_to_blueprint(payload)
        except BlueprintDecodeError as exc:
            return {"success": False, "error": f"Could not encode blueprint: {exc}"}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"success": True, "path": str(path), "file_name": path.name}

    if path.suffix.lower() != ".qb":
        path = path.with_suffix(".qb")

    document = QubicleDocument.from_dict(payload).to_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(document)

    return {"success": True, "path": str(path), "file_name": path.name}


@eel.expose
@standardize_response
def build_blueprint_render(path_str, game_path_str=None):
    """On-demand full-detail render of a blueprint (the "Rendered (decos)" layer).

    Explodes the block-resolution build by 12 and drops each resolved deco model in
    at full voxel detail. Returns the QB document, or an error string when the build
    is too large to render (the cap protects the editor from tens of millions of
    voxels). Built lazily because it is expensive (hundreds of thousands of voxels).
    """
    path = Path(str(path_str or "").strip())
    if not path.exists() or path.suffix.lower() != ".blueprint":
        return {"success": False, "error": "Blueprint file does not exist."}
    try:
        doc = blueprint_render_document(path, game_path=game_path_str or None)
    except BlueprintDecodeError as exc:
        return {"success": False, "error": f"Could not render blueprint: {exc}"}
    except Exception as exc:
        return {"success": False, "error": f"Render failed: {exc}"}
    if "error" in doc:
        return {"success": False, "error": doc["error"],
                "voxel_estimate": doc.get("voxel_estimate")}
    return {"success": True, "document": doc}


@eel.expose
@standardize_response
def export_blueprint_render(path_str, out_path_str, game_path_str=None):
    """Write the FULL uncapped exploded render (body + all decos at 12³/block) to a
    .qb file. The live editor can't draw a whole house (its 2D viewport builds a
    face per voxel), but a GPU voxel viewer opens the exported .qb with no limit."""
    path = Path(str(path_str or "").strip())
    out = str(out_path_str or "").strip()
    if not path.exists() or path.suffix.lower() != ".blueprint":
        return {"success": False, "error": "Blueprint file does not exist."}
    if not out:
        return {"success": False, "error": "No output path was provided."}
    try:
        result = _bp_export_render(path, out, game_path=game_path_str or None)
    except BlueprintDecodeError as exc:
        return {"success": False, "error": f"Could not render blueprint: {exc}"}
    except Exception as exc:
        return {"success": False, "error": f"Render export failed: {exc}"}
    if "error" in result:
        return {"success": False, "error": result["error"],
                "voxel_estimate": result.get("voxel_estimate")}
    return {"success": True, **result}


@eel.expose
@standardize_response
def get_block_mapping(game_path_str=None):
    """Dynamic block registry read straight from the game's mapping.binfab.

    Returns every placeable block's (index, type, style, colour, identifier),
    so the editor can name blocks / build the colour palette without a static
    JSON. New blocks shipped in game updates are picked up automatically.
    """
    if not game_path_str:
        return {"success": False, "error": "No game path was provided."}
    try:
        records = load_block_mapping(game_path_str)
    except Exception as exc:
        return {"success": False, "error": f"Could not read block mapping: {exc}"}
    if not records:
        return {"success": False, "error": "mapping.binfab not found in this game install."}
    return {"success": True, "count": len(records), "blocks": records}


@eel.expose
@standardize_response
def get_block_catalogue(game_path_str=None):
    """Full block/deco prefab catalogue from prefabs/blocks/blocks.binfab:
    every prefab identifier + the paths it references (item given, models,
    localization keys, ...). Dynamic -- picks up new prefabs from updates."""
    if not game_path_str:
        return {"success": False, "error": "No game path was provided."}
    try:
        records = load_full_block_catalogue(game_path_str)
    except Exception as exc:
        return {"success": False, "error": f"Could not read block catalogue: {exc}"}
    if not records:
        return {"success": False, "error": "blocks.binfab not found in this game install."}
    return {"success": True, "count": len(records), "prefabs": records}


@eel.expose
@standardize_response
def get_material_presets():
    """Named presets for the strict blueprint map layers so the editor can offer
    clickable options ("Metal", "Glass", "50%") instead of raw RGB. Values come
    from the verified material tables (no hardcoded magic in the UI)."""
    try:
        from models.trove.blueprint_maps import material_presets
        return {"success": True, "presets": material_presets()}
    except Exception as exc:
        return {"success": False, "error": f"Could not build material presets: {exc}"}


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

def _safe_extract_target(dest_root: Path, internal_path: str):
    """Resolve a .tmod's internal file path under dest_root, refusing anything
    that would escape it. .tmod headers are untrusted input, so a path that is
    absolute, has a drive, or contains '..' must not be allowed to write outside
    the chosen destination. Returns the target Path or None if it's unsafe."""
    raw = str(internal_path or "").replace("\\", "/")
    parts = []
    for part in PurePosixPath(raw).parts:
        if part in ("", "/", "."):
            continue
        if part == ".." or ":" in part:
            return None
        parts.append(part)
    if not parts:
        return None
    candidate = dest_root.joinpath(*parts)
    try:
        resolved = candidate.resolve()
        root_resolved = dest_root.resolve()
    except OSError:
        return None
    if resolved != root_resolved and root_resolved not in resolved.parents:
        return None
    return candidate


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
        skipped = []
        for file in mod.files:
            _raise_if_cancelled("extract_tmod")
            out_path = _safe_extract_target(dest_path, file.trove_path)
            if out_path is None:
                skipped.append(str(file.trove_path))
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)

            out_path.write_bytes(file.data)
            extracted_count += 1

        result = {"success": True, "count": extracted_count}
        if skipped:
            result["skipped"] = skipped
        return result
    except OperationCancelled as e:
        return {"success": False, "cancelled": True, "error": str(e)}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


@eel.expose
@standardize_response
def load_tmod_for_edit(tmod_path_str):
    try:
        tmod_path = Path(str(tmod_path_str or "").strip())
        if not tmod_path.exists() or not tmod_path.is_file():
            return {"success": False, "error": "TMod file does not exist."}

        mod = TMod.read_bytes(tmod_path, tmod_path.read_bytes())
        regular_files = []
        preview_data = None
        preview_name = ""
        config_data = None
        config_name = ""

        for file in mod.files:
            normalized_path = _normalize_internal_path(file.trove_path)
            if normalized_path and normalized_path == mod.preview_path:
                preview_data = _encode_data_url(file.data, "image/png")
                preview_name = Path(file.trove_path).name
                continue
            if normalized_path and normalized_path == mod.config_path:
                config_data = _encode_data_url(file.data, "text/plain")
                # The real embedded name, not a fixed "default.cfg": mods built
                # since the rename carry ui/<title>.cfg, older ones ui/default.cfg.
                config_name = Path(file.trove_path).name
                continue

            regular_files.append({
                "internal_path": file.trove_path,
                "name": Path(file.trove_path).name,
                "source": "archive",
                "path": "",
                "data": _encode_data_url(file.data),
            })

        tags, subtype = _split_type_and_subtype(mod.tags or [], mod.subtype or "")

        return {
            "success": True,
            "data": {
                "tmodPath": str(tmod_path),
                "fileName": tmod_path.name,
                "title": mod.name or tmod_path.stem,
                "author": mod.author or "",
                "version": mod.get_property_value("modVersion") or "1.0",
                "notes": mod.notes or "",
                "tags": tags,
                "subtype": subtype,
                "previewBase64": preview_data,
                "previewName": preview_name,
                "configBase64": config_data,
                "configName": config_name,
                "files": regular_files,
            },
        }
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
            
        valid_dirs = {d.value.lower() for d in Directories}
        files = []

        # Walk with scandir and prune: once the internal path has a first
        # component it can no longer change, so a subtree that does not start
        # with a game directory can never contribute. On a real install that
        # skips `extracted/`, which is ~96% of the files.
        stack = [(str(source_dir), (), False)]
        while stack:
            current_dir, internal_parts, in_override = stack.pop()
            _raise_if_cancelled("detect_overrides")
            try:
                entries = list(os.scandir(current_dir))
            except OSError:
                continue

            for entry in entries:
                is_override = entry.name.lower() == "override"
                child_parts = internal_parts if is_override else internal_parts + (entry.name,)
                if child_parts and child_parts[0].lower() not in valid_dirs:
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    continue
                if is_dir:
                    stack.append((entry.path, child_parts, in_override or is_override))
                elif (in_override or is_override) and child_parts:
                    files.append({
                        "path": entry.path,
                        "internal_path": "/".join(child_parts)
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
        subtype = payload.get("subtype", "").strip()
        files = payload.get("files", [])
        
        if not author: return {"success": False, "error": "Mod author is required."}
        if not version: return {"success": False, "error": "Mod version is required."}
        if not notes: return {"success": False, "error": "Mod notes are required."}
        if not tags: return {"success": False, "error": "At least one tag is required."}
        if not files: return {"success": False, "error": "At least one file is required."}

        config_data = _decode_data_url(payload.get("configBase64"))
        config_path = _config_internal_path(title) if config_data is not None else None

        preview_name = payload.get("previewName", "preview.png")
        preview_path = _preview_internal_path(title, preview_name) if payload.get("previewBase64") else None

        path_error = _validate_special_paths(
            [f.get("internal_path", f.get("name", "unknown_file")) for f in files],
            preview_path=preview_path.as_posix() if preview_path else None,
            include_config=config_data is not None,
            title=title,
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

        for tag in _combine_tags_with_subtype(tags, subtype):
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
def save_tmod_in_place(payload):
    try:
        _reset_cancel_flag("build_tmod")

        tmod_path_str = str(payload.get("tmodPath", "")).strip()
        if not tmod_path_str:
            return {"success": False, "error": "No TMod file was selected."}

        source_path = Path(tmod_path_str)
        if not source_path.exists() or not source_path.is_file():
            return {"success": False, "error": "Selected TMod file does not exist."}

        title = payload.get("title", "").strip()
        if title.lower().endswith(".tmod"):
            title = title[:-5].strip()
        if not title:
            return {"success": False, "error": "Mod title is required."}
        if re.search(r'[<>:"/\\|?*]', title):
            return {"success": False, "error": "Mod title contains illegal characters (< > : \" / \\ | ? *)."}

        save_path = source_path.with_name(f"{title}.tmod")

        author = payload.get("author", "").strip()
        version = payload.get("version", "").strip()
        notes = payload.get("notes", "").strip()
        tags = payload.get("tags", [])
        subtype = payload.get("subtype", "").strip()
        files = payload.get("files", [])

        if not author:
            return {"success": False, "error": "Mod author is required."}
        if not version:
            return {"success": False, "error": "Mod version is required."}
        if not notes:
            return {"success": False, "error": "Mod notes are required."}
        if len(notes) > 220:
            return {"success": False, "error": "Mod notes cannot exceed 220 characters."}
        if not tags:
            return {"success": False, "error": "At least one tag is required."}
        if not files:
            return {"success": False, "error": "At least one file is required."}

        overwrite = bool(payload.get("overwrite", False))
        if save_path.exists() and save_path.resolve() != source_path.resolve() and not overwrite:
            return {
                "success": False,
                "code": "FILE_EXISTS",
                "error": f"A mod file named '{save_path.name}' already exists.",
                "path": str(save_path),
            }
        if save_path.exists() and save_path.resolve() == source_path.resolve() and not overwrite:
            return {
                "success": False,
                "code": "FILE_EXISTS",
                "error": f"A mod file named '{save_path.name}' already exists.",
                "path": str(save_path),
            }

        preview_name = payload.get("previewName", "preview.png")
        preview_path = _preview_internal_path(title, preview_name) if payload.get("previewBase64") else None

        config_data = _decode_data_url(payload.get("configBase64"))
        config_path = _config_internal_path(title) if config_data is not None else None

        path_error = _validate_special_paths(
            [f.get("internal_path", f.get("name", "unknown_file")) for f in files],
            preview_path=preview_path.as_posix() if preview_path else None,
            include_config=config_data is not None,
            title=title,
        )
        if path_error:
            return {"success": False, "error": path_error}

        mod = TMod()
        mod.mod_path = save_path
        mod.name = title
        mod.author = author
        mod.add_property("modVersion", version)
        mod.notes = notes
        for tag in _combine_tags_with_subtype(tags, subtype):
            mod.add_tag(tag)
        mod.add_property("compileDate", str(int(datetime.now(UTC).timestamp())))

        preview_bytes = _decode_data_url(payload.get("previewBase64"))
        if preview_bytes is not None and preview_path is not None:
            mod.add_file(TroveModFile(preview_path, preview_bytes))
            mod.preview_path = preview_path

        if config_data is not None and config_path is not None:
            mod.add_file(TroveModFile(config_path, config_data))
            mod.config_path = config_path

        for file in files:
            _raise_if_cancelled("build_tmod")
            internal_path = Path(file.get("internal_path", file.get("name", "unknown_file")))
            abs_path = str(file.get("path", "")).strip()

            file_bytes = None
            if abs_path and Path(abs_path).exists():
                file_bytes = Path(abs_path).read_bytes()
            else:
                file_bytes = _decode_data_url(file.get("data"))

            if file_bytes is None:
                return {"success": False, "error": f"Missing file data for {internal_path.as_posix()}."}

            mod.add_file(TroveModFile(internal_path, file_bytes))

        if save_path.exists() and overwrite:
            save_path.unlink(missing_ok=True)
        save_path.write_bytes(mod.compile_tmod())
        return {"success": True, "path": str(save_path), "fileName": save_path.name}
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
            data.setdefault("subtype", "")
            data["versions"] = sorted(list(set(versions + data.get("versions", []))))
            return {"success": True, "data": data}
        else:
            default_data = {
                "title": project_path.name,
                "author": "",
                "notes": "",
                "tags": [],
                "subtype": "",
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
        subtype = meta.get("subtype", "").strip()

        if not title:
            return {"success": False, "error": "Project title cannot be empty."}
        if re.search(r'[<>:"/\\|?*]', title):
            return {"success": False, "error": "Project title contains illegal characters."}

        mod = TMod()
        mod.name = title
        mod.author = author
        mod.add_property("modVersion", version.strip())
        mod.notes = notes
        for tag in _combine_tags_with_subtype(tags, subtype):
            mod.add_tag(tag)
        
        mod.add_property("compileDate", str(int(datetime.now(UTC).timestamp())))

        preview_b64 = meta.get("previewBase64")
        preview_name = meta.get("previewName", "preview.png")
        preview_path = _preview_internal_path(title, preview_name) if preview_b64 else None
        config_data = _decode_data_url(meta.get("configBase64"))
        config_path = _config_internal_path(title) if config_data is not None else None
        path_error = _validate_special_paths(
            [file_path.relative_to(target_dir).as_posix() for file_path in target_dir.rglob("*") if file_path.is_file()],
            preview_path=preview_path.as_posix() if preview_path else None,
            include_config=config_data is not None,
            title=title,
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
