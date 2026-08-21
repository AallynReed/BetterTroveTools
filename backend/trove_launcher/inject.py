"""Hand a Trion ticket to Trove the way Glyph does (Windows only).

The game does NOT take the ticket on the command line. The launcher:
  1. builds a RC4-encrypted "RIFT" blob from the ticket,
  2. drops it in an inheritable page-file-backed file-mapping,
  3. creates an inheritable auto-reset event,
  4. CreateProcess()es the game with the two handle values plus its own pid in
     `-k "0x<map>:0x<evt>:<launcherpid>"` and the auth-server list in `-C "..."`,
     whitelisting exactly those two handles for inheritance,
  5. waits on the event - the game signals it once it has read + decrypted the
     ticket (the game reads the blob by OpenProcess(launcherpid)+DuplicateHandle,
     which is why our own pid is passed and why we must keep the handles open).

ANTI-CHEAT (XIGNCODE3, added 2026-07): the game is no longer launched directly.
Glyph now launches the loader `xldr_Trove_GL_loader_x64.exe`, passing the real
game exe name as argv[0]. Verified from GlyphClient.0.log:
  Executable: <GameDir>/xldr_Trove_GL_loader_x64.exe
  Arguments : trove_x64.exe -k {credentials}:{glyphpid} -C "[AuthServer] ..."
The loader initializes the anti-cheat, then loads the named game exe with the
same -k/-C args. So we point CreateProcess at the loader and set argv[0] to the
game exe basename. If the loader is absent (older build) we fall back to the old
direct `Trove_x64.exe -k ... -C ...` launch.
"""

from __future__ import annotations

import ctypes
import secrets
import struct
from ctypes import POINTER, byref, c_size_t, cast, sizeof, wintypes
from pathlib import Path

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# constants
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1)
PAGE_READWRITE = 0x04
FILE_MAP_WRITE = 0x0002
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
# Reparenting: make the loader a child of a chosen process (GlyphClientApp) so
# the process ancestry matches a real Glyph launch. XIGNCODE's server-side
# attestation appears to encode the launch chain — a python-rooted tree gets
# leaderboards refused even though the game itself runs fine.
PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = 0x00020000
PROCESS_CREATE_PROCESS = 0x0080
TH32CS_SNAPPROCESS = 0x00000002
STILL_ACTIVE = 259
WAIT_OBJECT_0 = 0x0
WAIT_TIMEOUT = 0x102

RIFT_MAGIC = b"\x54\x46\x49\x52"  # 'TFIR' bytes == "RIFT" read as LE uint32

# The map/event handles handed to the game via -k must stay open in THIS (the
# launcher) process for as long as the game might read them. The game pulls the
# ticket blob by OpenProcess(launcherpid)+DuplicateHandle — exactly how it reads
# them from GlyphClientApp, which keeps them open for the whole session. If we
# close them right after launch (or let their numeric values get recycled), the
# game duplicates the wrong/empty object, never gets credentials, and bounces
# back to login. So we stash them here and deliberately keep them open for the
# process lifetime (a 2-handle "leak" per launch, mirroring Glyph).
_SESSION_HANDLES: list[int] = []


# --- structs ----------------------------------------------------------------


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", wintypes.DWORD),
                ("lpSecurityDescriptor", wintypes.LPVOID),
                ("bInheritHandle", wintypes.BOOL)]


LPSECURITY_ATTRIBUTES = POINTER(SECURITY_ATTRIBUTES)


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD),
                ("lpReserved", wintypes.LPWSTR),
                ("lpDesktop", wintypes.LPWSTR),
                ("lpTitle", wintypes.LPWSTR),
                ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
                ("dwFillAttribute", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD),
                ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
                ("lpReserved2", POINTER(wintypes.BYTE)),
                ("hStdInput", wintypes.HANDLE),
                ("hStdOutput", wintypes.HANDLE),
                ("hStdError", wintypes.HANDLE)]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW),
                ("lpAttributeList", wintypes.LPVOID)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


# --- prototypes (argtypes set so 64-bit handles aren't truncated) -----------

kernel32.CreateFileMappingW.restype = wintypes.HANDLE
kernel32.CreateFileMappingW.argtypes = [wintypes.HANDLE, LPSECURITY_ATTRIBUTES,
                                        wintypes.DWORD, wintypes.DWORD,
                                        wintypes.DWORD, wintypes.LPCWSTR]
kernel32.MapViewOfFile.restype = wintypes.LPVOID
kernel32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, c_size_t]
kernel32.UnmapViewOfFile.argtypes = [wintypes.LPCVOID]
kernel32.CreateEventW.restype = wintypes.HANDLE
kernel32.CreateEventW.argtypes = [LPSECURITY_ATTRIBUTES, wintypes.BOOL,
                                  wintypes.BOOL, wintypes.LPCWSTR]
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, POINTER(wintypes.DWORD)]
kernel32.InitializeProcThreadAttributeList.argtypes = [wintypes.LPVOID, wintypes.DWORD,
                                                       wintypes.DWORD, POINTER(c_size_t)]
kernel32.UpdateProcThreadAttribute.argtypes = [wintypes.LPVOID, wintypes.DWORD, c_size_t,
                                               wintypes.LPVOID, c_size_t,
                                               wintypes.LPVOID, POINTER(c_size_t)]
kernel32.DeleteProcThreadAttributeList.argtypes = [wintypes.LPVOID]
kernel32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR,
                                    LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES,
                                    wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID,
                                    wintypes.LPCWSTR, wintypes.LPVOID,
                                    POINTER(PROCESS_INFORMATION)]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260)]


kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, POINTER(PROCESSENTRY32W)]
kernel32.Process32FirstW.restype = wintypes.BOOL
kernel32.Process32NextW.argtypes = [wintypes.HANDLE, POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.restype = wintypes.BOOL


def _werr(msg: str) -> OSError:
    return ctypes.WinError(ctypes.get_last_error()) if ctypes.get_last_error() else OSError(msg)


def find_pid_by_name(name: str) -> int | None:
    """Return a PID whose exe basename matches ``name`` (case-insensitive).

    Uses the Toolhelp snapshot so we don't drag in psutil here (inject stays
    dependency-free). If several processes match, the last one enumerated wins —
    good enough for a singleton like GlyphClientApp.exe."""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE.value:
        return None
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = sizeof(PROCESSENTRY32W)
        found = None
        ok = kernel32.Process32FirstW(snap, byref(entry))
        while ok:
            if entry.szExeFile.lower() == name.lower():
                found = entry.th32ProcessID
            ok = kernel32.Process32NextW(snap, byref(entry))
        return found
    finally:
        kernel32.CloseHandle(snap)


_MAX_ANCESTOR_HOPS = 6


def find_pids_under(name: str, ancestor_pid: int) -> list[int]:
    """PIDs whose exe basename matches ``name`` and that descend from
    ``ancestor_pid``, directly or through an intermediate process.

    Used to find the CrashHandler.exe belonging to one game instance. The walk
    up is depth-limited because a dead parent leaves a stale ppid behind."""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE.value:
        return []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = sizeof(PROCESSENTRY32W)
        parents, matches = {}, []
        ok = kernel32.Process32FirstW(snap, byref(entry))
        while ok:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            if entry.szExeFile.lower() == name.lower():
                matches.append(entry.th32ProcessID)
            ok = kernel32.Process32NextW(snap, byref(entry))
    finally:
        kernel32.CloseHandle(snap)

    found = []
    for pid in matches:
        cur = pid
        for _ in range(_MAX_ANCESTOR_HOPS):
            cur = parents.get(cur, 0)
            if not cur:
                break
            if cur == ancestor_pid:
                found.append(pid)
                break
    return found


# --- payload ----------------------------------------------------------------


def rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 0xFF
        s[i], s[j] = s[j], s[i]
    out = bytearray(len(data))
    i = j = 0
    for n, b in enumerate(data):
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        out[n] = b ^ s[(s[i] + s[j]) & 0xFF]
    return bytes(out)


def build_rift_buffer(ticket: str, rc_key: bytes | None = None) -> bytes:
    """rcKey(8) ++ ciphertextLen(uint32 LE) ++ RC4(magic ++ ticket ++ \\0)."""
    lines = ticket.replace("\r", "").split("\n")
    start = next((i for i, ln in enumerate(lines)
                  if ln.startswith("Signature:") or ln.startswith("<?xml")), 0)
    clean = "\n".join(lines[start:]).rstrip()
    content = clean.encode("utf-8") + b"\x00"
    plaintext = RIFT_MAGIC + content
    rc_key = rc_key or secrets.token_bytes(8)
    ct = rc4(rc_key, plaintext)
    return rc_key + struct.pack("<I", len(ct)) + ct


# --- launch -----------------------------------------------------------------


def spawn(game_exe: Path, ticket: str, auth_server: str, *,
          wait_ms: int = 30000, parent_process_name: str | None = None,
          log=print) -> int:
    """Inject the ticket and launch the game. Returns the new process id.

    `game_exe` points at the real game binary (e.g. GameLive/Trove_x64.exe). If
    the XIGNCODE loader sits next to it we launch THROUGH the loader (the game
    binary's name becomes argv[0]); otherwise we launch the game directly.

    ``parent_process_name`` (e.g. "GlyphClientApp.exe"): when set and that process
    is running, the loader is spawned as a CHILD of it, so the ancestry becomes
    <parent> -> loader -> Trove, matching a genuine Glyph launch. This is for the
    XIGNCODE leaderboard-attestation issue — see PROC_THREAD_ATTRIBUTE_PARENT_PROCESS
    above. If the named process isn't running (or can't be opened) we log and fall
    back to a normal launch; the game still runs, only the ancestry differs.
    """
    game_exe = Path(game_exe)

    # Route through the anti-cheat loader when present (current live build).
    # Glyph's exact CreateProcess, verified from a Security-4688 cmdline audit:
    #   lpApplicationName = xldr_Trove_GL_loader_x64.exe
    #   lpCommandLine     = "<loader path>" trove_x64.exe -k <map>:<evt>:<pid> -C "..." -lang en
    # The loader's OWN path is argv[0] and the GAME exe name is argv[1]; the loader
    # reads argv[1] to know which binary to start and passes argv[2:] through to it.
    # Putting the game name in argv[0] shifts everything and the loader aborts with
    # exit code 1038 before it ever spawns the game.
    loader = game_exe.with_name("xldr_Trove_GL_loader_x64.exe")
    via_loader = loader.exists()
    exe_to_run = loader if via_loader else game_exe

    buf = build_rift_buffer(ticket)

    sa = SECURITY_ATTRIBUTES(nLength=sizeof(SECURITY_ATTRIBUTES),
                             lpSecurityDescriptor=None, bInheritHandle=True)

    hmap = kernel32.CreateFileMappingW(INVALID_HANDLE_VALUE, byref(sa),
                                       PAGE_READWRITE, 0, len(buf), None)
    if not hmap:
        raise _werr("CreateFileMapping failed")
    view = kernel32.MapViewOfFile(hmap, FILE_MAP_WRITE, 0, 0, len(buf))
    if not view:
        kernel32.CloseHandle(hmap)
        raise _werr("MapViewOfFile failed")
    ctypes.memmove(view, buf, len(buf))
    kernel32.UnmapViewOfFile(view)

    hevent = kernel32.CreateEventW(byref(sa), False, False, None)
    if not hevent:
        kernel32.CloseHandle(hmap)
        raise _werr("CreateEvent failed")

    # Resolve the reparent target BEFORE sizing the attribute list — its presence
    # decides whether we add one attribute (handle list) or two (+ parent process).
    parent_handle = None
    if parent_process_name:
        ppid = find_pid_by_name(parent_process_name)
        if not ppid:
            log(f"[inject] reparent: {parent_process_name} not running — launching "
                f"without reparent (ancestry stays this process)")
        else:
            parent_handle = kernel32.OpenProcess(PROCESS_CREATE_PROCESS, False, ppid)
            if not parent_handle:
                log(f"[inject] reparent: OpenProcess({parent_process_name} pid {ppid}) "
                    f"failed (err {ctypes.get_last_error()}) — launching without reparent")
            else:
                log(f"[inject] reparent: loader will be a child of "
                    f"{parent_process_name} (pid {ppid})")

    # The attribute list carries EITHER the handle-list whitelist OR the parent-
    # process override — never both. Windows rejects the combination with
    # ERROR_INVALID_PARAMETER (87), because once a parent is specified the
    # whitelisted handles must belong to THAT parent, not to us. That's fine:
    # when we reparent we drop the whitelist and let the game pull the ticket the
    # way it does under Glyph — OpenProcess(launcherpid)+DuplicateHandle against
    # us (we keep hmap/hevent open in _SESSION_HANDLES, and -k still carries our
    # pid), which needs no inheritance at all.
    size = c_size_t(0)
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, byref(size))
    attr = ctypes.create_string_buffer(size.value)
    attr_p = cast(attr, wintypes.LPVOID)
    if not kernel32.InitializeProcThreadAttributeList(attr_p, 1, 0, byref(size)):
        raise _werr("InitializeProcThreadAttributeList failed")
    if parent_handle:
        hParent = wintypes.HANDLE(parent_handle)
        if not kernel32.UpdateProcThreadAttribute(
                attr_p, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
                byref(hParent), sizeof(hParent), None, None):
            raise _werr("UpdateProcThreadAttribute (parent process) failed")
    else:
        handles = (wintypes.HANDLE * 2)(wintypes.HANDLE(hmap), wintypes.HANDLE(hevent))
        if not kernel32.UpdateProcThreadAttribute(attr_p, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                                  handles, sizeof(handles), None, None):
            raise _werr("UpdateProcThreadAttribute (handle list) failed")

    si = STARTUPINFOEXW()
    si.StartupInfo.cb = sizeof(STARTUPINFOEXW)
    si.lpAttributeList = attr_p
    pi = PROCESS_INFORMATION()

    import os
    my_pid = os.getpid()
    kc = f"{hmap:08x}:{hevent:08x}:{my_pid}"
    if via_loader:
        # argv[0]=loader path, argv[1]=game exe name, then the game's own args.
        cmd = f'"{exe_to_run}" {game_exe.name} -k {kc} -C "{auth_server}" -lang en'
    else:
        cmd = f'"{game_exe}" -k {kc} -C "{auth_server}"'
    cmd_buf = ctypes.create_unicode_buffer(cmd)
    log(f"[inject] launching ({'loader' if via_loader else 'direct'}): "
        f"{exe_to_run.name} :: {game_exe.name + ' ' if via_loader else ''}"
        f"-k {kc} -C \"[AuthServer]...\"{' -lang en' if via_loader else ''}")

    # Inherit handles only in the non-reparent path (that path relies on the
    # whitelisted handle list). When reparenting there's no handle list and the
    # ticket comes via DuplicateHandle, so inheritance is off — matching Glyph.
    inherit_handles = parent_handle is None
    ok = kernel32.CreateProcessW(
        str(exe_to_run), cast(cmd_buf, wintypes.LPWSTR), None, None, inherit_handles,
        EXTENDED_STARTUPINFO_PRESENT, None, str(exe_to_run.parent), byref(si), byref(pi),
    )
    kernel32.DeleteProcThreadAttributeList(attr_p)
    if parent_handle:
        kernel32.CloseHandle(parent_handle)
    if not ok:
        err = _werr("CreateProcess failed")
        kernel32.CloseHandle(hmap)
        kernel32.CloseHandle(hevent)
        raise err

    kernel32.CloseHandle(pi.hThread)
    pid = pi.dwProcessId

    res = kernel32.WaitForSingleObject(hevent, wait_ms)
    if res == WAIT_OBJECT_0:
        log(f"[inject] game consumed the ticket (pid {pid})")
    elif res == WAIT_TIMEOUT:
        code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(pi.hProcess, byref(code))
        if code.value == STILL_ACTIVE:
            log(f"[inject] WARNING: pid {pid} didn't signal in {wait_ms}ms; may still recover")
        else:
            log(f"[inject] ERROR: pid {pid} exited (code {code.value}) before consuming ticket")
    else:
        log(f"[inject] WaitForSingleObject -> 0x{res:x}")

    # Keep hmap/hevent OPEN for the launcher's lifetime (see _SESSION_HANDLES) so
    # the game can still duplicate the ticket blob from us after XIGNCODE's slow
    # init — Glyph likewise never closes them mid-session. Only the loader's
    # process handle is safe to release here.
    _SESSION_HANDLES.extend((hmap, hevent))
    kernel32.CloseHandle(pi.hProcess)
    return pid
