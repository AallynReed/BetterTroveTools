"""Publish .tmod files to the Trove Steam Workshop without launching the game.

Trove's own uploader is the in-game `/workshop upload` chat command, which
refuses to run unless the client was started through Steam. It is not
privileged though -- it is the public Steamworks UGC API. Any 64-bit process
that initialises as app 304050 can do the same thing, so this module binds the
flat C API of the Steam copy's `steam_api64.dll` with ctypes and drives it.

Things that cost real time to establish, and that the code below depends on:

  * The DLL must come from the STEAM install of Trove. The Glyph copy ships the
    same file, but Steam does not own that install.
  * `SteamAppId` must be in the environment before `SteamAPI_Init`, and
    `SteamAPI_RestartAppIfNecessary` must never be called -- its whole job is to
    relaunch the game through Steam, which is the thing we are avoiding.
  * A workshop item is a FOLDER. `SetItemContent` takes a directory, and Trove
    reports "No .tmod files found in subscribed directory" if the .tmod is not
    inside one. Staging is `<temp>/<Title>/<Title>.tmod`.
  * Do NOT call `SteamAPI_RunCallbacks` while polling a `SteamAPICall_t`. With
    no `CCallResult` registered there is nothing for the dispatcher to hand a
    completion to, and a dispatched completion is a freed one.
  * The staging directory must outlive the submit -- the content is read
    asynchronously, so deleting it when `SubmitItemUpdate` merely *returns* its
    call handle uploads nothing.
  * The shipped SDK is ~1.36 (STEAMUGC_INTERFACE_VERSION 005). There is no
    `DeleteItem` export; removing an item is a website action.
"""
from __future__ import annotations

import base64
import ctypes
import os
import re
import shutil
import tempfile
import threading
import time
from ctypes import (POINTER, Structure, byref, c_bool, c_char, c_char_p,
                    c_float, c_int32, c_uint32, c_uint64, c_void_p)
from pathlib import Path

import eel

from backend.response import standardize_response
from models.trove.mod import TMod
from utils.registry import get_trove_locations

APP_ID = 304050
ITEM_URL = "https://steamcommunity.com/sharedfiles/filedetails/?id={id}"
LEGAL_AGREEMENT_URL = "https://steamcommunity.com/sharedfiles/workshoplegalagreement"

# k_iSteamUGCCallbacks is 3400.
CB_QUERY_COMPLETED = 3401
CB_CREATE_ITEM = 3403
CB_SUBMIT_ITEM_UPDATE = 3404

# ERemoteStoragePublishedFileVisibility
VIS_PUBLIC, VIS_FRIENDS, VIS_PRIVATE = 0, 1, 2

# EItemUpdateStatus -> stage keys the UI translates.
UPDATE_STATUS = {
    0: "invalid", 1: "preparing_config", 2: "preparing_content",
    3: "uploading_content", 4: "uploading_preview", 5: "committing",
}

# The EResult values that actually turn up here. Anything else falls back to the
# bare number so a novel failure is still identifiable in a bug report.
ERESULT = {
    1: "OK", 2: "Generic failure", 3: "No connection to Steam",
    8: "Invalid parameter", 9: "File not found", 15: "Access denied",
    16: "Timed out", 21: "Not logged on", 25: "Limit exceeded",
    26: "Revoked", 27: "Expired", 66: "File too large",
}

# Steam's own field caps. Exceeding them fails the submit with a bare "invalid
# parameter", so trim before we get there.
MAX_TITLE = 128
MAX_DESCRIPTION = 8000
MAX_PREVIEW_BYTES = 1024 * 1024


# --- ctypes structs ---------------------------------------------------------
# All of these are #pragma pack(8) on the C side. Natural alignment under
# _pack_ = 8 reproduces the documented offsets; the assertions below keep that
# honest, because two of the jumps (steam_id_owner, file_handle) are the kind of
# thing a hand-rolled layout gets wrong and then garbles everything after.

class CreateItemResult(Structure):
    _pack_ = 8
    _fields_ = [
        ("result", c_int32),
        ("published_file_id", c_uint64),
        ("needs_legal_agreement", c_bool),
    ]


class SubmitItemUpdateResult(Structure):
    _pack_ = 8
    _fields_ = [
        ("result", c_int32),
        ("needs_legal_agreement", c_bool),
    ]


class SteamUGCQueryCompleted(Structure):
    _pack_ = 8
    _fields_ = [
        ("handle", c_uint64),
        ("result", c_int32),
        ("num_results_returned", c_uint32),
        ("total_matching_results", c_uint32),
        ("cached_data", c_bool),
    ]


class SteamUGCDetails(Structure):
    """Version 005 of the struct (total size 9776). The fixed char arrays are
    what make the layout, so it has to be declared in full even though we only
    read a handful of fields."""
    _pack_ = 8
    _fields_ = [
        ("published_file_id", c_uint64),
        ("result", c_int32),
        ("file_type", c_int32),
        ("creator_app_id", c_uint32),
        ("consumer_app_id", c_uint32),
        ("title", c_char * 129),
        ("description", c_char * 8000),
        ("steam_id_owner", c_uint64),
        ("time_created", c_uint32),
        ("time_updated", c_uint32),
        ("time_added_to_user_list", c_uint32),
        ("visibility", c_int32),
        ("banned", c_bool),
        ("accepted_for_use", c_bool),
        ("tags_truncated", c_bool),
        ("tags", c_char * 1025),
        ("file_handle", c_uint64),
        ("preview_file_handle", c_uint64),
        ("file_name", c_char * 260),
        ("file_size", c_int32),
        ("preview_file_size", c_int32),
        ("url", c_char * 256),
        ("votes_up", c_uint32),
        ("votes_down", c_uint32),
        ("score", c_float),
        ("num_children", c_uint32),
    ]


class SteamParamStringArray(Structure):
    _pack_ = 8
    _fields_ = [("strings", POINTER(c_char_p)), ("count", c_int32)]


class SteamError(RuntimeError):
    """A failure the user can act on -- surfaced verbatim in the UI."""


def _check_layout() -> None:
    """The struct layouts are what every read here depends on. Two alignment
    jumps in particular (steam_id_owner at 8160, file_handle at 9216) garble
    everything after them if they drift."""
    expected = [
        (ctypes.sizeof(CreateItemResult), 24, "CreateItemResult size"),
        (ctypes.sizeof(SubmitItemUpdateResult), 8, "SubmitItemUpdateResult size"),
        (ctypes.sizeof(SteamUGCQueryCompleted), 24, "SteamUGCQueryCompleted size"),
        (ctypes.sizeof(SteamUGCDetails), 9776, "SteamUGCDetails size"),
        (SteamUGCDetails.steam_id_owner.offset, 8160, "SteamUGCDetails.steam_id_owner offset"),
        (SteamUGCDetails.file_handle.offset, 9216, "SteamUGCDetails.file_handle offset"),
    ]
    for actual, want, what in expected:
        if actual != want:
            raise SteamError(f"Steam struct layout mismatch: {what} is {actual}, expected {want}.")


def _eresult(code) -> str:
    return ERESULT.get(int(code), f"EResult {int(code)}")


_SIGNATURES = {
    "SteamAPI_Init": ([], c_bool),
    "SteamAPI_Shutdown": ([], None),
    "SteamAPI_IsSteamRunning": ([], c_bool),
    "SteamUGC": ([], c_void_p),
    "SteamUtils": ([], c_void_p),
    "SteamUser": ([], c_void_p),
    "SteamFriends": ([], c_void_p),
    "SteamAPI_ISteamUser_GetSteamID": ([c_void_p], c_uint64),
    "SteamAPI_ISteamUser_BLoggedOn": ([c_void_p], c_bool),
    "SteamAPI_ISteamFriends_GetPersonaName": ([c_void_p], c_char_p),
    "SteamAPI_ISteamUtils_GetAppID": ([c_void_p], c_uint32),
    "SteamAPI_ISteamUtils_IsAPICallCompleted": ([c_void_p, c_uint64, POINTER(c_bool)], c_bool),
    "SteamAPI_ISteamUtils_GetAPICallResult": (
        [c_void_p, c_uint64, c_void_p, c_int32, c_int32, POINTER(c_bool)], c_bool),
    "SteamAPI_ISteamUGC_CreateItem": ([c_void_p, c_uint32, c_int32], c_uint64),
    "SteamAPI_ISteamUGC_StartItemUpdate": ([c_void_p, c_uint32, c_uint64], c_uint64),
    "SteamAPI_ISteamUGC_SetItemTitle": ([c_void_p, c_uint64, c_char_p], c_bool),
    "SteamAPI_ISteamUGC_SetItemDescription": ([c_void_p, c_uint64, c_char_p], c_bool),
    "SteamAPI_ISteamUGC_SetItemTags": ([c_void_p, c_uint64, POINTER(SteamParamStringArray)], c_bool),
    "SteamAPI_ISteamUGC_SetItemContent": ([c_void_p, c_uint64, c_char_p], c_bool),
    "SteamAPI_ISteamUGC_SetItemPreview": ([c_void_p, c_uint64, c_char_p], c_bool),
    "SteamAPI_ISteamUGC_SetItemVisibility": ([c_void_p, c_uint64, c_int32], c_bool),
    "SteamAPI_ISteamUGC_SubmitItemUpdate": ([c_void_p, c_uint64, c_char_p], c_uint64),
    "SteamAPI_ISteamUGC_GetItemUpdateProgress": (
        [c_void_p, c_uint64, POINTER(c_uint64), POINTER(c_uint64)], c_int32),
    "SteamAPI_ISteamUGC_CreateQueryUserUGCRequest": (
        [c_void_p, c_uint32, c_int32, c_int32, c_int32, c_uint32, c_uint32, c_uint32], c_uint64),
    "SteamAPI_ISteamUGC_SendQueryUGCRequest": ([c_void_p, c_uint64], c_uint64),
    "SteamAPI_ISteamUGC_GetQueryUGCResult": ([c_void_p, c_uint64, c_uint32, POINTER(SteamUGCDetails)], c_bool),
    "SteamAPI_ISteamUGC_ReleaseQueryUGCRequest": ([c_void_p, c_uint64], c_bool),
}

INVALID_HANDLE = 0xFFFFFFFFFFFFFFFF


def find_steam_api_dll():
    """(dll, steam Trove install) for the first Steam copy of Trove found."""
    if os.name != "nt":
        return None, None
    try:
        installs = get_trove_locations()
    except Exception:
        return None, None
    for game in installs:
        if not getattr(game, "is_steam", False):
            continue
        dll = Path(game.path).joinpath("steam_api64.dll")
        if dll.exists():
            return dll, Path(game.path)
    return None, None


class SteamSession:
    """One initialised Steamworks session. Not reentrant -- guard with _LOCK."""

    def __init__(self):
        self._dll = None
        self.dll_path = None
        self.game_path = None
        self.ugc = None
        self.utils = None
        self.user = None
        self.friends = None
        self._account = None
        self._saved_env = {}

    @property
    def connected(self) -> bool:
        return self._dll is not None and self.ugc is not None

    def connect(self) -> None:
        if self.connected:
            return
        if os.name != "nt":
            raise SteamError("Steam Workshop uploads are Windows-only.")
        _check_layout()
        dll_path, game_path = find_steam_api_dll()
        if dll_path is None:
            raise SteamError(
                "No Steam copy of Trove was found. Publishing needs steam_api64.dll "
                "from the Steam install -- Glyph installs ship the same file, but "
                "Steam does not own them."
            )

        dll = ctypes.CDLL(str(dll_path))
        for name, (argtypes, restype) in _SIGNATURES.items():
            fn = getattr(dll, name)
            fn.argtypes = argtypes
            fn.restype = restype

        if not dll.SteamAPI_IsSteamRunning():
            self._free(dll)
            raise SteamError("Steam is not running. Start Steam, sign in, and try again.")

        # Identify as Trove without dropping a steam_appid.txt next to the exe.
        for key in ("SteamAppId", "SteamGameId"):
            self._saved_env[key] = os.environ.get(key)
            os.environ[key] = str(APP_ID)

        # Deliberately NOT SteamAPI_RestartAppIfNecessary -- see module docstring.
        if not dll.SteamAPI_Init():
            self._restore_env()
            self._free(dll)
            raise SteamError(
                "Steam refused the connection. Make sure Steam is running and "
                "signed in to an account that owns Trove."
            )

        self._dll = dll
        self.dll_path = dll_path
        self.game_path = game_path
        self.ugc = dll.SteamUGC()
        self.utils = dll.SteamUtils()
        self.user = dll.SteamUser()
        self.friends = dll.SteamFriends()
        if not self.ugc or not self.utils:
            self.disconnect()
            raise SteamError("Steam returned no UGC interface (unexpected SDK version).")

    def disconnect(self) -> None:
        dll, self._dll = self._dll, None
        self.ugc = self.utils = self.user = self.friends = self._account = None
        self.dll_path = self.game_path = None
        if dll is None:
            return
        try:
            dll.SteamAPI_Shutdown()
        except Exception:
            pass
        self._restore_env()
        self._free(dll)

    def _restore_env(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._saved_env.clear()

    @staticmethod
    def _free(dll) -> None:
        # Drop the module so the next connect() starts from a fresh image rather
        # than re-initialising a DLL that was already shut down once.
        try:
            ctypes.windll.kernel32.FreeLibrary(ctypes.c_void_p(dll._handle))
        except Exception:
            pass

    # --- account -----------------------------------------------------------

    @property
    def cached_account(self):
        """The identity read at connect time. Status polls use this so they never
        call into the DLL while the upload thread is using the session."""
        return self._account

    def account(self) -> dict:
        steam_id = int(self._dll.SteamAPI_ISteamUser_GetSteamID(self.user)) if self.user else 0
        persona = ""
        if self.friends:
            raw = self._dll.SteamAPI_ISteamFriends_GetPersonaName(self.friends)
            persona = (raw or b"").decode("utf-8", "replace")
        self._account = {
            "persona": persona,
            "steam_id": str(steam_id),
            "account_id": steam_id & 0xFFFFFFFF,
            "logged_on": bool(self._dll.SteamAPI_ISteamUser_BLoggedOn(self.user)) if self.user else False,
            "profile_url": f"https://steamcommunity.com/profiles/{steam_id}" if steam_id else "",
        }
        return self._account

    # --- async plumbing ----------------------------------------------------

    def wait(self, call, struct_type, callback_id, timeout=300.0, on_tick=None):
        """Poll a SteamAPICall_t to completion and return the filled struct.

        Polling only -- no SteamAPI_RunCallbacks; see the module docstring.
        """
        if not call:
            raise SteamError("Steam did not return a call handle.")
        failed = c_bool(False)
        result = struct_type()
        deadline = time.monotonic() + timeout
        while not self._dll.SteamAPI_ISteamUtils_IsAPICallCompleted(self.utils, call, byref(failed)):
            if time.monotonic() > deadline:
                raise SteamError("Timed out waiting on Steam.")
            if on_tick:
                on_tick()
            time.sleep(0.1)
        if failed.value:
            raise SteamError("Steam reported the call as failed.")
        ok = self._dll.SteamAPI_ISteamUtils_GetAPICallResult(
            self.utils, call, byref(result), ctypes.sizeof(struct_type),
            callback_id, byref(failed))
        if not ok or failed.value:
            raise SteamError("Could not read the result of the Steam call.")
        return result

    # --- queries -----------------------------------------------------------

    def published_items(self, max_pages: int = 10) -> list:
        """Every workshop item this account has published for Trove.

        Steam has no lookup by title, so this doubles as the duplicate guard --
        it is what the game itself matches against on a repeat upload.
        """
        account_id = int(self._dll.SteamAPI_ISteamUser_GetSteamID(self.user)) & 0xFFFFFFFF
        items = []
        page = 1
        while page <= max_pages:
            # 0, 0, 0 = EUserUGCList Published, EUGCMatchingUGCType Items,
            # EUserUGCListSortOrder CreationOrderDesc.
            handle = self._dll.SteamAPI_ISteamUGC_CreateQueryUserUGCRequest(
                self.ugc, account_id, 0, 0, 0, APP_ID, APP_ID, page)
            if not handle or handle == INVALID_HANDLE:
                raise SteamError("Steam refused the workshop query.")
            try:
                call = self._dll.SteamAPI_ISteamUGC_SendQueryUGCRequest(self.ugc, handle)
                completed = self.wait(call, SteamUGCQueryCompleted, CB_QUERY_COMPLETED, timeout=60)
                if completed.result != 1:
                    raise SteamError(f"Workshop query failed: {_eresult(completed.result)}")
                details = SteamUGCDetails()
                for index in range(completed.num_results_returned):
                    if self._dll.SteamAPI_ISteamUGC_GetQueryUGCResult(
                            self.ugc, handle, index, byref(details)):
                        items.append(_details_to_dict(details))
                total = int(completed.total_matching_results)
                returned = int(completed.num_results_returned)
            finally:
                self._dll.SteamAPI_ISteamUGC_ReleaseQueryUGCRequest(self.ugc, handle)
            if returned == 0 or len(items) >= total:
                break
            page += 1
        return items

    # --- publishing --------------------------------------------------------

    def create_item(self) -> CreateItemResult:
        # 0 = k_EWorkshopFileTypeCommunity
        call = self._dll.SteamAPI_ISteamUGC_CreateItem(self.ugc, APP_ID, 0)
        result = self.wait(call, CreateItemResult, CB_CREATE_ITEM, timeout=120)
        if result.result != 1:
            raise SteamError(f"Steam would not create the item: {_eresult(result.result)}")
        return result

    def submit_update(self, item_id, *, title=None, description=None, tags=None,
                      content_dir=None, preview=None, visibility=None,
                      change_note="", on_progress=None) -> SubmitItemUpdateResult:
        handle = self._dll.SteamAPI_ISteamUGC_StartItemUpdate(self.ugc, APP_ID, int(item_id))
        if not handle or handle == INVALID_HANDLE:
            raise SteamError("Steam would not start an item update.")

        if title is not None:
            self._dll.SteamAPI_ISteamUGC_SetItemTitle(self.ugc, handle, _cstr(title))
        if description is not None:
            self._dll.SteamAPI_ISteamUGC_SetItemDescription(self.ugc, handle, _cstr(description))
        if tags is not None:
            encoded = [_cstr(tag) for tag in tags]
            array_type = c_char_p * max(len(encoded), 1)
            buffer = array_type(*encoded) if encoded else array_type()
            param = SteamParamStringArray(
                ctypes.cast(buffer, POINTER(c_char_p)), c_int32(len(encoded)))
            self._dll.SteamAPI_ISteamUGC_SetItemTags(self.ugc, handle, byref(param))
        if content_dir is not None:
            self._dll.SteamAPI_ISteamUGC_SetItemContent(self.ugc, handle, _cstr(str(content_dir)))
        if preview is not None:
            self._dll.SteamAPI_ISteamUGC_SetItemPreview(self.ugc, handle, _cstr(str(preview)))
        if visibility is not None:
            self._dll.SteamAPI_ISteamUGC_SetItemVisibility(self.ugc, handle, int(visibility))

        call = self._dll.SteamAPI_ISteamUGC_SubmitItemUpdate(self.ugc, handle, _cstr(change_note))

        def tick():
            if not on_progress:
                return
            done, total = c_uint64(0), c_uint64(0)
            status = self._dll.SteamAPI_ISteamUGC_GetItemUpdateProgress(
                self.ugc, handle, byref(done), byref(total))
            on_progress(UPDATE_STATUS.get(int(status), "invalid"), int(done.value), int(total.value))

        result = self.wait(call, SubmitItemUpdateResult, CB_SUBMIT_ITEM_UPDATE, on_tick=tick)
        if result.result != 1:
            raise SteamError(f"Steam rejected the upload: {_eresult(result.result)}")
        return result


def _cstr(value) -> bytes:
    return str(value or "").encode("utf-8")


def _details_to_dict(d: SteamUGCDetails) -> dict:
    return {
        "id": str(d.published_file_id),
        "title": d.title.decode("utf-8", "replace"),
        "description": d.description.decode("utf-8", "replace"),
        "tags": [t.strip() for t in d.tags.decode("utf-8", "replace").split(",") if t.strip()],
        "visibility": int(d.visibility),
        "banned": bool(d.banned),
        "file_size": int(d.file_size),
        "preview_file_size": int(d.preview_file_size),
        "time_created": int(d.time_created),
        "time_updated": int(d.time_updated),
        "url": ITEM_URL.format(id=d.published_file_id),
    }


_SESSION = SteamSession()
_LOCK = threading.RLock()
_BUSY = threading.Lock()


# --- .tmod metadata ---------------------------------------------------------

def _safe_name(value: str) -> str:
    """A title that is safe as a folder/file name on Windows."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(value or "")).strip().rstrip(".")
    return cleaned or "Trove Mod"


def read_tmod_metadata(tmod_path: Path) -> dict:
    """Everything the publish form needs, taken straight out of the archive."""
    mod = TMod.read_bytes(tmod_path, tmod_path.read_bytes())

    preview_bytes = None
    preview_name = ""
    for mod_file in mod.files:
        if mod.preview_path and mod_file.trove_path == mod.preview_path:
            preview_bytes = mod_file.data
            preview_name = Path(mod_file.trove_path).name
            break

    title = mod.name or tmod_path.stem
    # Trove writes the mod's type tags and its class subtype into the same tag
    # list on the workshop item, so keep both.
    tags = list(mod.tags or [])
    if mod.subtype and mod.subtype not in tags:
        tags.append(mod.subtype)

    return {
        "path": str(tmod_path),
        "fileName": tmod_path.name,
        "fileSize": tmod_path.stat().st_size,
        "fileCount": len(mod.files),
        "title": title,
        "author": mod.author or "",
        "description": mod.notes or "",
        "tags": tags,
        "subtype": mod.subtype or "",
        "modVersion": mod.get_property_value("modVersion") or "",
        "gameVersion": mod.game_version or "",
        # Trove stores the workshop id it published under back into the archive;
        # when it is there it beats any title match.
        "steamId": (mod.steam_id or "").strip(),
        "previewBase64": (
            "data:image/png;base64," + base64.b64encode(preview_bytes).decode("utf-8")
            if preview_bytes else None
        ),
        "previewName": preview_name,
        "previewSize": len(preview_bytes) if preview_bytes else 0,
        "previewTooLarge": bool(preview_bytes and len(preview_bytes) > MAX_PREVIEW_BYTES),
    }


# --- progress plumbing ------------------------------------------------------

def _emit(stage: str, **fields) -> None:
    """Push one progress frame to the Steam tab (fire-and-forget)."""
    payload = {"stage": stage}
    payload.update(fields)
    try:
        eel.receive_steam_workshop_progress(payload)
    except Exception:
        pass  # UI not listening (view not mounted) -- nothing to do


# --- publish ----------------------------------------------------------------

def _stage_upload(tmod_path: Path, title: str, preview_source: Path | None):
    """Build `<temp>/<Title>/<Title>.tmod` plus a sibling preview image.

    The preview deliberately sits OUTSIDE the content folder -- everything in
    that folder is uploaded as the item's content.
    """
    root = Path(tempfile.mkdtemp(prefix="troveworkshop-upload-"))
    safe = _safe_name(title)
    content_dir = root / safe
    content_dir.mkdir()
    shutil.copy2(tmod_path, content_dir / f"{safe}.tmod")

    preview_path = None
    if preview_source is not None:
        suffix = preview_source.suffix.lower() or ".png"
        preview_path = root / f"{safe}-Preview{suffix}"
        shutil.copy2(preview_source, preview_path)
    return root, content_dir, preview_path


def _extract_preview(tmod_path: Path, root: Path) -> Path | None:
    mod = TMod.read_bytes(tmod_path, tmod_path.read_bytes())
    if not mod.preview_path:
        return None
    for mod_file in mod.files:
        if mod_file.trove_path == mod.preview_path:
            suffix = Path(mod_file.trove_path).suffix.lower() or ".png"
            out = root / f"embedded-preview{suffix}"
            out.write_bytes(mod_file.data)
            return out
    return None


def _run_publish(payload: dict) -> None:
    scratch = None
    staging = None
    try:
        tmod_path = Path(str(payload.get("tmodPath") or "").strip())
        if not tmod_path.is_file():
            raise SteamError("That .tmod file no longer exists.")

        title = str(payload.get("title") or "").strip()[:MAX_TITLE]
        if not title:
            raise SteamError("A title is required.")
        description = str(payload.get("description") or "")[:MAX_DESCRIPTION]
        tags = [str(t).strip() for t in (payload.get("tags") or []) if str(t).strip()]
        visibility = int(payload.get("visibility", VIS_PRIVATE))
        if visibility not in (VIS_PUBLIC, VIS_FRIENDS, VIS_PRIVATE):
            visibility = VIS_PRIVATE
        change_note = str(payload.get("changeNote") or "")
        existing_id = str(payload.get("itemId") or "").strip()

        _emit("staging")
        scratch = Path(tempfile.mkdtemp(prefix="troveworkshop-preview-"))
        preview_override = str(payload.get("previewPath") or "").strip()
        if preview_override:
            preview_source = Path(preview_override)
            if not preview_source.is_file():
                raise SteamError("The chosen preview image no longer exists.")
        else:
            preview_source = _extract_preview(tmod_path, scratch)
        if preview_source is not None and preview_source.stat().st_size > MAX_PREVIEW_BYTES:
            raise SteamError(
                "Steam caps workshop preview images at 1 MB; this one is "
                f"{preview_source.stat().st_size / 1024:.0f} KB. Pick a smaller image."
            )

        staging, content_dir, preview_path = _stage_upload(tmod_path, title, preview_source)

        with _LOCK:
            _SESSION.connect()
            account = _SESSION.account()
            _emit("connected", account=account)

            created = False
            # Steam raises this on either call, and if it is set the item stays
            # invisible whatever visibility was asked for -- so keep whichever
            # one saw it rather than letting the second answer overwrite it.
            needs_legal = False
            if existing_id:
                item_id = int(existing_id)
            else:
                _emit("creating")
                result = _SESSION.create_item()
                item_id = int(result.published_file_id)
                created = True
                needs_legal = bool(result.needs_legal_agreement)
                _emit("created", itemId=str(item_id), url=ITEM_URL.format(id=item_id))

            def on_progress(status, done, total):
                _emit("uploading", itemId=str(item_id), status=status,
                      done=done, total=total)

            # A brand-new item goes up private no matter what was asked for: the
            # id exists the moment CreateItem returns, and committing it public
            # in the same submit publishes it before anyone has seen the page.
            first_visibility = VIS_PRIVATE if created else visibility
            submitted = _SESSION.submit_update(
                item_id, title=title, description=description, tags=tags,
                content_dir=content_dir, preview=preview_path,
                visibility=first_visibility, change_note=change_note,
                on_progress=on_progress,
            )
            needs_legal = needs_legal or bool(submitted.needs_legal_agreement)

            if created and visibility != VIS_PRIVATE:
                _emit("visibility")
                # Visibility-only: nothing is re-uploaded.
                _SESSION.submit_update(item_id, visibility=visibility,
                                       change_note=change_note)

            _emit("verifying", itemId=str(item_id))
            published = next(
                (i for i in _SESSION.published_items() if i["id"] == str(item_id)), None)

        # Steam's "success" is not proof the bytes landed -- compare what it
        # holds against what we handed it.
        expected_content = tmod_path.stat().st_size
        expected_preview = preview_path.stat().st_size if preview_path else 0
        verified = bool(
            published
            and published["file_size"] == expected_content
            and published["preview_file_size"] == expected_preview
        )

        _emit("done", ok=True, finished=True, created=created, itemId=str(item_id),
              url=ITEM_URL.format(id=item_id), item=published, verified=verified,
              expectedFileSize=expected_content, expectedPreviewSize=expected_preview,
              needsLegalAgreement=needs_legal, legalAgreementUrl=LEGAL_AGREEMENT_URL,
              visibility=visibility)
    except Exception as exc:  # noqa: BLE001 -- every failure belongs in the UI
        _emit("error", ok=False, finished=True, error=str(exc))
    finally:
        # Only now: the content is read asynchronously, so an earlier cleanup
        # would upload nothing.
        for path in (staging, scratch):
            if path:
                shutil.rmtree(path, ignore_errors=True)
        _BUSY.release()


# --- eel API ----------------------------------------------------------------

@eel.expose
@standardize_response
def steam_workshop_status():
    dll_path, game_path = find_steam_api_dll()
    steam_running = False
    if _SESSION.connected:
        steam_running = True
    elif dll_path is not None:
        # Cheap probe that does not initialise a session.
        try:
            probe = ctypes.CDLL(str(dll_path))
            probe.SteamAPI_IsSteamRunning.restype = c_bool
            steam_running = bool(probe.SteamAPI_IsSteamRunning())
            SteamSession._free(probe)
        except Exception:
            steam_running = False
    return {
        "supported": os.name == "nt",
        "dllPath": str(dll_path) if dll_path else "",
        "gamePath": str(game_path) if game_path else "",
        "steamRunning": steam_running,
        "connected": _SESSION.connected,
        "busy": _BUSY.locked(),
        "account": _SESSION.cached_account,
    }


@eel.expose
@standardize_response
def steam_workshop_connect():
    with _LOCK:
        _SESSION.connect()
        return {"connected": True, "account": _SESSION.account(),
                "dllPath": str(_SESSION.dll_path), "gamePath": str(_SESSION.game_path)}


@eel.expose
@standardize_response
def steam_workshop_disconnect():
    with _LOCK:
        _SESSION.disconnect()
        return {"connected": False}


@eel.expose
@standardize_response
def steam_workshop_read_tmod(tmod_path_str):
    path = Path(str(tmod_path_str or "").strip())
    if not path.is_file():
        return {"success": False, "error": "That .tmod file does not exist."}
    return read_tmod_metadata(path)


@eel.expose
@standardize_response
def steam_workshop_list_items():
    with _LOCK:
        _SESSION.connect()
        return {"items": _SESSION.published_items(), "account": _SESSION.account()}


@eel.expose
@standardize_response
def steam_workshop_set_visibility(item_id, visibility):
    with _LOCK:
        _SESSION.connect()
        _SESSION.submit_update(int(item_id), visibility=int(visibility))
        return {"itemId": str(item_id), "visibility": int(visibility)}


@eel.expose
@standardize_response
def steam_workshop_publish(payload):
    """Kick the upload off on a worker thread; progress arrives via
    receive_steam_workshop_progress."""
    if not _BUSY.acquire(blocking=False):
        return {"success": False, "error": "An upload is already running."}
    threading.Thread(target=_run_publish, args=(dict(payload or {}),),
                     daemon=True, name="steam-workshop-publish").start()
    return {"started": True}
