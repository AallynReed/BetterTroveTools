"""Modpack Profiles — locally-saved `.tpack` loadouts.

A *profile* is a `.tpack` (a curated modpack bundle) saved into the app's data
folder so it can be re-applied without re-downloading. Profiles are global
(game-agnostic): the same saved bundle can be applied to whichever Trove install
the user has selected.

Storage (`%APPDATA%/Trove/Profiles` on Windows, via utils.path.get_app_data_dir):
  * `index.json` — a manifest of profile metadata (display name, hub source,
    mod count, timestamps). Metadata only; the `.tpack` files are the source of
    truth, so a corrupt/missing manifest is rebuilt from the bundles on disk.
  * `<id>.tpack` — the saved bundle. `id` is a uuid4 hex (rename never touches
    the file, only the manifest's `display_name`).

Applying a profile is a FULL SWITCH: every currently-enabled mod in the game's
`mods/` folder is moved aside into `mods/disabled/`, then the profile's mods are
installed. Before applying, each inner mod is checked against the Mods Hub (the
ground truth for updates); if newer hub releases exist the UI can rebuild the
saved `.tpack` with them first (`update_profile_file`).
"""

import hashlib
import json
import uuid
from pathlib import Path

import eel
import requests

from backend.mod_manager import mods_hub
from backend.mod_manager.modpacks import (USER_AGENT, _decompile_tpack,
                                          _decompile_tpack_meta,
                                          _download_tpack, _install_tpack_bytes,
                                          _name_from_filename, _rebuild_tpack,
                                          _unique_path)
from backend.response import resp
from utils.path import get_app_data_dir
from utils.registry import TroveGamePath


def _profiles_dir() -> Path:
    return get_app_data_dir() / "Profiles"


def _manifest_path() -> Path:
    return _profiles_dir() / "index.json"


def _profile_file(profile_id) -> Path:
    return _profiles_dir() / f"{profile_id}.tpack"


def _load_manifest() -> dict:
    """Read the profiles manifest. On a missing/corrupt manifest, rebuild a
    minimal one from the `.tpack` files on disk (the bundles are authoritative)."""
    path = _manifest_path()
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(manifest, dict) and isinstance(manifest.get("profiles"), list):
            return manifest
    except (OSError, json.JSONDecodeError, AttributeError):
        pass

    profiles = []
    pdir = _profiles_dir()
    if pdir.exists():
        known = set()
        for tpack in pdir.glob("*.tpack"):
            pid = tpack.stem
            if pid in known:
                continue
            known.add(pid)
            profiles.append({
                "id": pid,
                "display_name": pid,
                "handle": None,
                "slug": None,
                "variant": None,
                "mod_count": 0,
                "created_at": None,
                "updated_at": None,
            })
    return {"profiles": profiles}


def _save_manifest(manifest: dict):
    pdir = _profiles_dir()
    pdir.mkdir(parents=True, exist_ok=True)
    _manifest_path().write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def _find(manifest: dict, profile_id):
    for entry in manifest.get("profiles", []):
        if entry.get("id") == profile_id:
            return entry
    return None


# --- update checking (Mods Hub is the ground truth) ------------------------

def _lookup(hashes):
    """POST a batch of sha256s to the Mods Hub /lookup -> ({hash: {mod, release}},
    ok). `ok` is False when the hub couldn't be reached, so callers can tell
    "checked, nothing new" apart from "couldn't check (offline)"."""
    if not hashes:
        return {}, True
    req_id = None
    try:
        req_id = eel.add_external_request("Checking Profile Mods", f"{mods_hub.KIWI_API_BASE}/mods/lookup")()
    except Exception:
        pass
    try:
        resp = requests.post(
            f"{mods_hub.KIWI_API_BASE}/mods/lookup",
            json={"hashes": list(hashes)},
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=15,
        )
        if req_id:
            eel.remove_external_request(req_id, resp.status_code == 200)()
            req_id = None
        if resp.status_code == 200:
            return (resp.json() or {}).get("results", {}) or {}, True
        return {}, False
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Profile update lookup failed: {e}")
        return {}, False


def _resolve_updates(entries):
    """For a profile's inner mods ([(filename, tmod_bytes)]), resolve which have a
    newer Mods Hub release on the installed branch. Returns (updates, checked):
      updates = [{name, filename, ref, branch, download_url}]
      checked = False when the hub was unreachable (so the UI can skip prompting)."""
    hash_to_entry = {}
    for filename, content in entries:
        digest = hashlib.sha256(bytes(content)).hexdigest()
        hash_to_entry.setdefault(digest, filename)

    checked = True
    matches = {}
    all_hashes = list(hash_to_entry.keys())
    for i in range(0, len(all_hashes), 200):
        batch = all_hashes[i:i + 200]
        results, ok = _lookup(batch)
        if not ok:
            checked = False
        matches.update(results)

    updates = []
    for digest, filename in hash_to_entry.items():
        entry = matches.get(digest)
        if not entry:
            continue
        mod = (entry or {}).get("mod") or {}
        matched = (entry or {}).get("release") or {}
        slug = mod.get("slug")
        if not slug:
            continue
        ref = mods_hub._mod_ref(mod.get("handle"), slug)
        detail = mods_hub._fetch_mod_detail(ref)
        releases = (detail or {}).get("releases") or []
        if not mods_hub._release_outdated(matched, releases):
            continue
        latest = mods_hub._latest_release(releases, matched.get("branch"))
        if not latest or not latest.get("download_url"):
            continue
        updates.append({
            "name": _name_from_filename(filename),
            "filename": filename,
            "ref": ref,
            "branch": matched.get("branch"),
            "download_url": latest.get("download_url"),
        })
    return updates, checked


def _download_release(url, label):
    """Download a single replacement `.tmod` from the hub. Returns (bytes, ok)."""
    req_id = None
    try:
        req_id = eel.add_external_request(f"Downloading {label}", url)()
    except Exception:
        pass
    try:
        dl = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=(10, 300))
        if req_id:
            eel.remove_external_request(req_id, dl.status_code == 200)()
            req_id = None
        if dl.status_code == 200:
            return dl.content, True
    except Exception as e:
        if req_id:
            eel.remove_external_request(req_id, False)()
        print(f"Profile mod download failed: {e}")
    return None, False


# --- eel surface -----------------------------------------------------------

@eel.expose
def list_profiles():
    """All saved profiles' metadata, newest first."""
    try:
        manifest = _load_manifest()
        profiles = list(manifest.get("profiles", []))
        profiles.sort(key=lambda p: (p.get("created_at") or 0), reverse=True)
        return resp(True, data={"profiles": profiles}, profiles=profiles)
    except Exception as e:
        return resp(False, error=str(e), code="PROFILES_LIST_FAILED")


@eel.expose
def save_modpack_as_profile(handle, slug, variant=None, display_name="", created_at=None):
    """Download a modpack's `.tpack` from the hub and save it as a local profile."""
    try:
        data, error = _download_tpack(handle, slug, variant)
        if error:
            return resp(False, error=error, code="MODPACK_DOWNLOAD_FAILED")

        try:
            entries = _decompile_tpack(data)
        except Exception as e:
            return resp(False, error=f"Couldn't read the modpack file: {e}", code="TPACK_READ_FAILED")
        if not entries:
            return resp(False, error="The modpack contained no mods.", code="EMPTY_MODPACK")

        manifest = _load_manifest()
        profile_id = uuid.uuid4().hex
        _profile_file(profile_id).parent.mkdir(parents=True, exist_ok=True)
        _profile_file(profile_id).write_bytes(data)

        name = (display_name or "").strip() or slug or "Modpack"
        entry = {
            "id": profile_id,
            "display_name": name,
            "handle": handle,
            "slug": slug,
            "variant": variant,
            "mod_count": len(entries),
            "created_at": created_at,
            "updated_at": created_at,
        }
        manifest.setdefault("profiles", []).append(entry)
        _save_manifest(manifest)
        return resp(True, data={"profile": entry}, profile=entry)
    except Exception as e:
        return resp(False, error=str(e), code="PROFILE_SAVE_FAILED")


@eel.expose
def rename_profile(profile_id, new_name, updated_at=None):
    try:
        name = (new_name or "").strip()
        if not name:
            return resp(False, error="A profile name is required.", code="EMPTY_NAME")
        manifest = _load_manifest()
        entry = _find(manifest, profile_id)
        if not entry:
            return resp(False, error="Profile not found.", code="PROFILE_NOT_FOUND")
        entry["display_name"] = name
        if updated_at is not None:
            entry["updated_at"] = updated_at
        _save_manifest(manifest)
        return resp(True, data={"profile": entry}, profile=entry)
    except Exception as e:
        return resp(False, error=str(e), code="PROFILE_RENAME_FAILED")


@eel.expose
def delete_profile(profile_id):
    try:
        manifest = _load_manifest()
        entry = _find(manifest, profile_id)
        manifest["profiles"] = [p for p in manifest.get("profiles", []) if p.get("id") != profile_id]
        _save_manifest(manifest)
        try:
            _profile_file(profile_id).unlink(missing_ok=True)
        except OSError as e:
            print(f"Failed to remove profile file {profile_id}: {e}")
        return resp(True, data={"deleted": bool(entry)}, deleted=bool(entry))
    except Exception as e:
        return resp(False, error=str(e), code="PROFILE_DELETE_FAILED")


@eel.expose
def check_profile_updates(profile_id):
    """Check (against the Mods Hub) whether any mods inside the saved profile have
    newer releases. Returns {checked, updates:[{name, ref, branch}]}. `checked` is
    False when the hub couldn't be reached, so the UI applies as-is silently."""
    try:
        path = _profile_file(profile_id)
        if not path.exists():
            return resp(False, error="Profile file not found.", code="PROFILE_FILE_NOT_FOUND")
        entries = _decompile_tpack(path.read_bytes())
        updates, checked = _resolve_updates(entries)
        public = [{"name": u["name"], "ref": u["ref"], "branch": u["branch"]} for u in updates]
        return resp(True, data={"checked": checked, "updates": public}, checked=checked, updates=public)
    except Exception as e:
        return resp(False, error=str(e), code="PROFILE_UPDATE_CHECK_FAILED")


@eel.expose
def update_profile_file(profile_id, updated_at=None):
    """Rebuild the saved `.tpack`, swapping each outdated inner mod for its latest
    Mods Hub release. Overwrites the saved file only after the rebuild is verified
    to round-trip, so a bad rebuild never destroys the user's working copy."""
    try:
        path = _profile_file(profile_id)
        if not path.exists():
            return resp(False, error="Profile file not found.", code="PROFILE_FILE_NOT_FOUND")

        version, props, entries = _decompile_tpack_meta(path.read_bytes())
        updates, _ = _resolve_updates(entries)
        if not updates:
            return resp(True, data={"updated": 0}, updated=0)

        by_filename = {u["filename"]: u for u in updates}
        new_entries = []
        updated = 0
        for filename, content in entries:
            upd = by_filename.get(filename)
            if upd:
                data, ok = _download_release(upd["download_url"], upd["name"])
                if ok and data:
                    new_entries.append((filename, data))
                    updated += 1
                    continue
            new_entries.append((filename, content))

        if not updated:
            return resp(False, error="Couldn't download any updated mods.", code="PROFILE_UPDATE_DOWNLOAD_FAILED")

        rebuilt = _rebuild_tpack(version, props, new_entries)

        # Safety: the rebuild must decompile back to exactly what we put in before
        # we overwrite the user's good copy.
        round_trip = _decompile_tpack(rebuilt)
        expected = [(n, bytes(c)) for n, c in new_entries]
        actual = [(n, bytes(c)) for n, c in round_trip]
        if actual != expected:
            return resp(False, error="Rebuilt modpack failed verification; the saved file was left unchanged.", code="PROFILE_REBUILD_VERIFY_FAILED")

        path.write_bytes(rebuilt)

        manifest = _load_manifest()
        entry = _find(manifest, profile_id)
        if entry:
            entry["mod_count"] = len(new_entries)
            if updated_at is not None:
                entry["updated_at"] = updated_at
            _save_manifest(manifest)

        return resp(True, data={"updated": updated}, updated=updated)
    except Exception as e:
        return resp(False, error=str(e), code="PROFILE_UPDATE_FAILED")


def _disable_current_loadout(game_path_str):
    """Move every currently-ENABLED mod in the game's `mods/` folder into
    `mods/disabled/` (matching the modpack quarantine convention). Scoped to the
    top level of `mods/` only — Steam Workshop mods live elsewhere and can't be
    moved, and already-disabled mods are left as-is. Returns the count moved."""
    import shutil

    trove_path = TroveGamePath(Path(game_path_str))
    mods_dir = trove_path.mods_path
    disabled_dir = mods_dir / "disabled"

    moved = 0
    for pattern in ("*.tmod", "*.zip"):
        for mod_file in mods_dir.glob(pattern):
            if not mod_file.is_file():
                continue
            try:
                disabled_dir.mkdir(parents=True, exist_ok=True)
                dest = _unique_path(disabled_dir / mod_file.name)
                shutil.move(str(mod_file), str(dest))
                moved += 1
            except OSError as e:
                print(f"Failed to disable mod {mod_file.name}: {e}")
    return moved


@eel.expose
def apply_profile(game_path_str, profile_id):
    """Full-switch apply: disable the current `mods/` loadout, then install the
    profile's mods. Returns counts of installed + disabled mods."""
    try:
        if not game_path_str:
            return resp(False, error="No game path provided.", code="MISSING_GAME_PATH")
        path = _profile_file(profile_id)
        if not path.exists():
            return resp(False, error="Profile file not found.", code="PROFILE_FILE_NOT_FOUND")

        data = path.read_bytes()
        disabled = _disable_current_loadout(game_path_str)

        ok, error, result = _install_tpack_bytes(game_path_str, data)
        if not ok:
            return resp(False, error=error, code="PROFILE_APPLY_FAILED")

        payload = dict(result)
        payload["disabled"] = disabled
        return resp(True, data=payload, **payload)
    except Exception as e:
        return resp(False, error=str(e), code="PROFILE_APPLY_FAILED")
