"""Parity fixtures for btt-core's `modder_tools` (backend/modder_tools/modder_tools.py and
steam_workshop.py).

    python tools/parity/modder_tools.py                    # rewrite the fixtures
    python tools/parity/modder_tools.py real <mods> <out>  # extract/read real mods

Writes core/tests/fixtures/modder_tools/: `seed/` (a small game folder, workspace,
projects and source mods) and `cases.json` (a sequence of endpoint calls with the
responses Python gave and the sandbox tree after the last one). The Rust test
`endpoints_match_python` copies the seed to a temp dir, replays the calls and diffs.
Paths in responses are written relative to the sandbox as {ROOT}; the clock is fixed.
"""

import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import eel  # noqa: E402

eel.add_external_request = lambda *a, **k: (lambda: None)
eel.remove_external_request = lambda *a, **k: (lambda: None)
eel.receive_steam_workshop_progress = lambda *a, **k: None

import backend.modder_tools.modder_tools as mt  # noqa: E402
import backend.modder_tools.steam_workshop as sw  # noqa: E402
from models.trove.mod import TMod, TroveModFile  # noqa: E402
from utils.functions import write_leb128  # noqa: E402

OUT = ROOT / "core" / "tests" / "fixtures" / "modder_tools"
FIXED_NOW = _dt.datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=_dt.UTC)


class FixedDateTime(_dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW


def tfi(names):
    out = bytearray()
    for i, name in enumerate(names):
        raw = name.encode("utf-8")
        out += write_leb128(len(raw)) + raw + write_leb128(0) + write_leb128(i * 10) + write_leb128(10) + write_leb128(1234)
    return bytes(out)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(data) if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))


def make_tmod(title, files, props=()):
    mod = TMod()
    mod.name = title
    mod.author = "tester"
    for k, v in props:
        mod.add_property(k, v)
    for path, data in files:
        mod.add_file(TroveModFile(Path(path), data))
    return mod


def build_seed(seed):
    shutil.rmtree(seed, ignore_errors=True)
    game = seed / "game"
    write(game / "ui" / "index.tfi", tfi(["hud.swf", "menu/main.swf", "Upper.SWF"]))
    write(game / "textures" / "index.tfi", tfi(["a.png", "sub/b.png"]))
    write(game / "textures" / "zz" / "index.tfi", tfi(["a.png", "c.png"]))
    write(game / "textures" / "aa" / "index.tfi", tfi(["d.png"]))
    write(game / "models" / "index.tfi", tfi(["ok.blueprint"]) + b"\x03\xff\xfe\xfd")
    write(game / "mods" / "keep.txt", "")

    ws = seed / "workspace"
    write(ws / "ui" / "hud.swf", b"hud")
    write(ws / "ui" / "deep" / "main.swf", b"main")
    write(ws / "ui" / "upper.swf", b"upper")
    write(ws / "ui" / "readme.txt", b"ignored")
    write(ws / "textures" / "stuff" / "a.png", b"apng")
    write(ws / "textures" / "c.png", b"cpng")
    write(ws / "textures" / "override" / "d.png", b"skipped")
    write(ws / "models" / "unknown.blueprint", b"nomap")
    write(ws / "audio" / "override" / "x.ogg", b"ogg")

    proj = seed / "projects" / "P1"
    write(proj / "project.json", json.dumps({"title": "Project One", "author": "me", "notes": "n", "tags": ["UI", "Knight"],
                                             "subtype": "Bard", "versions": ["1.0", "0.9"], "active_version": "1.0"}, indent=4))
    write(proj / "v1.0" / "ui" / "hud.swf", b"projhud")
    write(proj / "v1.0" / "textures" / "a.png", b"proja")
    write(proj / "v1.0" / "stray" / "b.png", b"strayb")
    write(proj / "v1.0" / "__work" / "x.png", b"dunder")
    write(proj / "v1.0" / "notes.txt", b"ignored")
    write(proj / "vv3" / "keep.swf", b"v")
    write(seed / "projects" / "Fresh" / ".keep", b"")  # git keeps no empty folders

    src = seed / "mods_src"
    src.mkdir(parents=True)
    with_preview = make_tmod("With Preview", [("ui/hud.swf", b"swfdata"), ("ui/With Preview.png", b"\x89PNG fake"),
                                              ("ui/With Preview.cfg", b"[hud.swf]\nx = 1")],
                             [("previewPath", "ui/with preview.png"), ("configPath", "ui/With Preview.cfg"),
                              ("tags", "UI,Knight"), ("subtype", "Bard"), ("notes", "some notes"), ("modVersion", "2.1")])
    write(src / "With Preview.tmod", with_preview.compile_tmod())
    evil = make_tmod("Evil", [("../evil.txt", b"x"), ("ui/fine.swf", b"y"), ("C:/abs.txt", b"z"), ("/rooted.swf", b"r")])
    write(src / "Evil.tmod", evil.compile_tmod())
    shutil.copy(ROOT / "core" / "tests" / "fixtures" / "modfile" / "unicode.tmod", src / "unicode.tmod")
    write(seed / "files" / "a.swf", b"file a")
    write(seed / "files" / "pic.jpeg", b"jpegdata")
    write(seed / "files" / "my.cfg", b"[a.swf]\nk = v")


def b64url(data, mime="application/octet-stream"):
    import base64
    return f"data:{mime};base64," + base64.b64encode(data).decode()


def calls():
    """(name, args) pairs; "{ROOT}" in a string arg is the sandbox root, and
    "{TOKEN}" the last undo token returned."""
    r = "{ROOT}"
    good = {
        "gamePath": f"{r}/game", "title": "Built Mod.tmod", "author": " me ", "version": "1.0", "notes": "notes",
        "tags": ["UI", "Knight", ""], "subtype": "Bard",
        "files": [{"internal_path": "UI/A.swf", "abs_path": f"{r}/files/a.swf"},
                  {"internal_path": "textures/x.png", "data": b64url(b"inline")},
                  {"name": "ui/nodata.swf"}],
        "previewBase64": b64url(b"jpegdata", "image/jpeg"), "previewName": "pic.JPEG",
        "configBase64": b64url(b"[a.swf]\nk = v", "text/plain"),
    }
    return [
        ("cancel_modder_tools_operation", ["bogus"]),
        ("cancel_modder_tools_operation", ["build_tmod"]),
        ("extract_tmod", [f"{r}/mods_src/With Preview.tmod", f"{r}/out/extract1"]),
        ("extract_tmod", [f"{r}/mods_src/Evil.tmod", f"{r}/out/extract2"]),
        ("extract_tmod", [f"{r}/mods_src/missing.tmod", f"{r}/out/extract3"]),
        ("extract_tmod", [None, f"{r}/out/x"]),
        ("load_tmod_for_edit", [f"{r}/mods_src/With Preview.tmod"]),
        ("load_tmod_for_edit", [f"  {r}/mods_src/unicode.tmod  "]),
        ("load_tmod_for_edit", [""]),
        ("detect_override_files", [f"{r}/workspace"]),
        ("detect_override_files", [f"{r}/nope"]),
        ("auto_structure_workspace", [f"{r}/workspace", f"{r}/game"]),
        ("auto_structure_workspace", [f"{r}/workspace", f"{r}/nope"]),
        ("detect_override_files", [f"{r}/workspace"]),
        ("get_missing_files", [[f"{r}/files/a.swf", f"{r}/files/none.swf", f"{r}/files"]]),
        ("get_missing_files", [None]),
        ("build_tmod", [good]),
        ("build_tmod", [good]),
        ("build_tmod", [dict(good, overwrite=True, title="Built Mod")]),
        ("build_tmod", [dict(good, title="Bad:Title")]),
        ("build_tmod", [dict(good, title=" ")]),
        ("build_tmod", [dict(good, author="")]),
        ("build_tmod", [dict(good, notes="x" * 221)]),
        ("build_tmod", [dict(good, tags=[])]),
        ("build_tmod", [dict(good, title="Dup", files=[{"internal_path": "ui/a.swf", "data": b64url(b"1")},
                                                      {"internal_path": "UI/A.SWF", "data": b64url(b"2")}])]),
        ("build_tmod", [dict(good, title="Cfg", configBase64=None, files=[{"internal_path": "ui/other.cfg", "data": b64url(b"1")}])]),
        ("build_tmod", [dict(good, title="Prev", files=[{"internal_path": "ui/prev.jpeg", "data": b64url(b"1")}])]),
        ("build_tmod", [dict(good, gamePath=f"{r}/nope")]),
        ("build_tmod", [dict(good, gamePath="")]),
        ("build_tmod", [dict(good, title=None)]),
        ("build_tmod", [None]),
        ("save_tmod_in_place", [{"tmodPath": f"{r}/game/mods/Built Mod.tmod", "title": "Renamed", "author": "me", "version": "2",
                                 "notes": "edited", "tags": ["UI"], "subtype": "", "overwrite": False,
                                 "files": [{"internal_path": "ui/a.swf", "path": f"{r}/files/a.swf"},
                                           {"internal_path": "ui/b.swf", "data": b64url(b"bee")}]}]),
        ("save_tmod_in_place", [{"tmodPath": f"{r}/game/mods/Renamed.tmod", "title": "Renamed", "author": "me", "version": "2",
                                 "notes": "edited", "tags": ["UI"], "files": [{"internal_path": "ui/a.swf", "path": f"{r}/files/a.swf"}]}]),
        ("save_tmod_in_place", [{"tmodPath": f"{r}/game/mods/Renamed.tmod", "title": "Renamed", "author": "me", "version": "3",
                                 "notes": "again", "tags": ["UI"], "overwrite": True,
                                 "files": [{"internal_path": "ui/a.swf", "path": ""}]}]),
        ("save_tmod_in_place", [{"tmodPath": None}]),
        ("save_tmod_in_place", [{"tmodPath": ""}]),
        ("load_mod_project", [f"{r}/projects/Fresh"]),
        ("load_mod_project", [f"{r}/projects/P1"]),
        ("load_mod_project", [f"{r}/projects/none"]),
        ("save_mod_project", [f"{r}/projects/P1", {"notes": "updated notes", "author": "you", "extra": [1, 2.5, None]}]),
        ("save_mod_project", [f"{r}/projects/P1", {"notes": "y" * 221}]),
        ("create_project_version", [f"{r}/projects/P1", "2.0"]),
        ("create_project_version", [f"{r}/projects/P1", "2.0"]),
        ("create_project_version", [f"{r}/projects/Fresh", "1.5"]),
        ("get_project_files", [f"{r}/projects/P1", "1.0"]),
        ("get_project_files", [f"{r}/projects/P1", "9.9"]),
        ("auto_structure_project_version", [f"{r}/projects/P1", "1.0", f"{r}/game"]),
        ("get_project_files", [f"{r}/projects/P1", "1.0"]),
        ("compile_project", [f"{r}/projects/P1", "1.0", f"{r}/game"]),
        ("compile_project", [f"{r}/projects/P1", "2.0", f"{r}/game"]),
        ("compile_project", [f"{r}/projects/Fresh", "1.0", f"{r}/game"]),
        ("place_project_overrides", [f"{r}/projects/P1", "1.0", f"{r}/game"]),
        ("detect_override_files", [f"{r}/game"]),
        ("remove_project_overrides", ["$placed_files"]),
        ("undo_remove_project_overrides", ["{TOKEN}"]),
        ("undo_remove_project_overrides", ["{TOKEN}"]),
        ("undo_remove_project_overrides", [None]),
        ("remove_project_overrides", [[f"{r}/files/none.swf"]]),
        ("steam_workshop_read_tmod", [f"{r}/mods_src/With Preview.tmod"]),
        ("steam_workshop_read_tmod", [f"{r}/mods_src/unicode.tmod"]),
        ("steam_workshop_read_tmod", [f"{r}/mods_src/missing.tmod"]),
        ("steam_workshop_publish", [5]),
    ]


DIALOGS = [
    ("ask_add_files", [f"{{ROOT}}/game"], ["{ROOT}/game/ui/override/hud.swf", "{ROOT}/game/textures/new.png", "{ROOT}/files/a.swf",
                                           "{ROOT}/game/ui/my.cfg", "{ROOT}/game/stray.png", "{ROOT}/GAME/Ui/case.swf"]),
    ("ask_add_files", [None], ["{ROOT}/game/ui/a.swf"]),
    ("ask_add_files", ["{ROOT}/game"], []),
    ("ask_preview_file", ["{ROOT}/game"], "{ROOT}/files/pic.jpeg"),
    ("ask_import_file", [None], "{ROOT}/files/a.swf"),
    ("ask_config_file", [None], "{ROOT}/files/my.cfg"),
    ("ask_config_file", [None], ""),
]


def substitute(value, root, token, placed):
    if isinstance(value, str):
        if value == "$placed_files":
            return placed
        return value.replace("{ROOT}", root).replace("{TOKEN}", token or "")
    if isinstance(value, list):
        return [substitute(v, root, token, placed) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, root, token, placed) for k, v in value.items()}
    return value


def normalize(value, root, token):
    if isinstance(value, str):
        for variant in (root, root.replace("\\", "/")):
            value = value.replace(variant, "{ROOT}")
        return value.replace(token, "{TOKEN}") if token else value
    if isinstance(value, list):
        return [normalize(v, root, token) for v in value]
    if isinstance(value, dict):
        return {k: normalize(v, root, token) for k, v in value.items()}
    return value


def snapshot(root, token):
    out = {}
    for p in sorted(Path(root).rglob("*")):
        rel = p.relative_to(root).as_posix()
        if token:
            rel = rel.replace(token, "{TOKEN}")
        rel = re.sub(r"ModderToolsTrash/[0-9a-f]{32}", "ModderToolsTrash/{UUID}", rel)
        out[rel] = hashlib.md5(p.read_bytes()).hexdigest() if p.is_file() else "dir"
    return out


def run():
    seed = OUT / "seed"
    build_seed(seed)
    sandbox = Path(tempfile.mkdtemp(prefix="btt-modder-parity-"))
    root = str(sandbox)
    shutil.copytree(seed, sandbox, dirs_exist_ok=True)
    os.environ["APPDATA"] = str(sandbox / "appdata")
    mt.datetime = FixedDateTime
    results = []
    token, placed = None, []
    with mock.patch.object(sw, "find_steam_api_dll", return_value=(None, None)):
        for name, args in calls():
            real_args = substitute(args, root, token, placed)
            fn = getattr(mt, name, None) or getattr(sw, name)
            response = fn(*real_args)
            if name == "remove_project_overrides" and response.get("undo_token"):
                token = response["undo_token"]
            if name == "place_project_overrides":
                placed = response.get("placed_files", [])
            results.append({"name": name, "args": args, "response": normalize(response, root, token)})
        for name, args, picked in DIALOGS:
            real_args = substitute(args, root, token, placed)
            real_pick = substitute(picked, root, token, placed)
            fake_tk = mock.MagicMock()
            with mock.patch.object(mt, "tk", fake_tk), mock.patch.object(mt, "filedialog") as fd:
                fd.askopenfilenames.return_value = tuple(p.replace("\\", "/") for p in real_pick) if isinstance(real_pick, list) else ()
                fd.askopenfilename.return_value = real_pick.replace("\\", "/") if isinstance(real_pick, str) else ""
                response = getattr(mt, name)(*real_args)
            results.append({"name": name, "args": args, "picked": picked, "response": normalize(response, root, token)})
    tree = snapshot(sandbox, token)
    (OUT / "cases.json").write_text(json.dumps({"fixed_now": FIXED_NOW.isoformat(), "calls": results, "tree": tree}, indent=1),
                                    encoding="utf-8")
    shutil.rmtree(sandbox, ignore_errors=True)
    print("wrote", len(results), "calls to", OUT / "cases.json")


def run_real(mods_dir, out_dir):
    """`real <mods> <out>`: extract and read every real .tmod, for the ignored Rust test
    `real_mods_extract_like_python` (BTT_PARITY_MODDER_REAL=<mods>;<out>)."""
    out = Path(out_dir)
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    report = {}
    for path in sorted(Path(mods_dir).iterdir()):
        if ".tmod" not in path.name:
            continue
        dest = out / "extract" / path.name
        entry = {"extract": mt.extract_tmod(str(path), str(dest))}
        for name, fn in (("edit", mt.load_tmod_for_edit), ("steam", sw.steam_workshop_read_tmod)):
            response = normalize(fn(str(path)), str(Path(mods_dir)), None)
            entry[name] = hashlib.md5(json.dumps(response, sort_keys=True).encode()).hexdigest()
        entry["tree"] = snapshot(dest, None) if dest.exists() else {}
        report[path.name] = entry
    (out / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("wrote", len(report), "mods to", out)


if __name__ == "__main__":
    if sys.argv[1:2] == ["real"]:
        run_real(sys.argv[2], sys.argv[3])
    else:
        run()
