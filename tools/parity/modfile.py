"""Parity fixtures for btt-core's `modfile` (models/trove/mod.py).

    python tools/parity/modfile.py fixtures            # rewrite core/tests/fixtures/modfile
    python tools/parity/modfile.py real <mods> <out>   # dump the Python view of real mods
    python tools/parity/modfile.py list <mods> <side>  # list a copy of <mods> as the Mod Manager does

`fixtures` records small golden files the Rust unit tests compare against. `real`
writes, for every mod in <mods>, what Python reads and rebuilds from it; `list` copies
the folder into <side>/game/mods and records the TroveModList (renames and ModCfgs
included). The ignored Rust tests `real_mods_match_python` and `mod_list_matches_python`
replay both (BTT_PARITY_REAL=<mods>;<out>, BTT_PARITY_LIST=<mods>;<python side>;<rust side>).
Run from the repo root with APPDATA pointed at a scratch directory.
"""

import base64
import hashlib
import io
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import eel  # noqa: E402

eel.add_external_request = lambda *a, **k: (lambda: None)
eel.remove_external_request = lambda *a, **k: (lambda: None)

import toml  # noqa: E402

from models.trove.mod import TMod, TroveModFile, ZMod, _normalize_internal_path  # noqa: E402

FIXTURES = ROOT / "core" / "tests" / "fixtures" / "modfile"

TOML_CASES = ["abc", "it's", 'say "hi"', "a\x01b", "\x01", "c:\\x", "a\\x41", "\u00e9\u4e2d", "tab\there",
              "x\x7fy", "\\\x01", "a\x01\x02", "nbsp\xa0", "q'\"", "\x00", ""]

PATH_CASES = ["UI/Thing.SWF", "ui\\x\\Y.png", "./a//b/", "", " spaced/ X.CFG ", "ui/My Mod.cfg", "C:/abs/x",
              "/root/x", "a/../b", "\u00c9t\u00e9/\u4e2d.swf", "ui/x.Cfg"]


def tmod_case(name, props, files, version=1):
    mod = TMod()
    mod.version = version
    for k, v in props:
        mod.add_property(k, v)
    for path, data in files:
        mod.add_file(TroveModFile(Path(path), data))
    return mod


def payload(n, seed):
    return bytes((i * seed + 7) % 251 for i in range(n))


def build_cases():
    return {
        "simple": tmod_case("simple", [("title", "Simple"), ("author", "me")], [("ui/a.swf", b"abc")]),
        "unicode": tmod_case("unicode", [("title", "Caf\u00e9 \u4e2d\u6587"), ("author", "\u00e9"), ("notes", "n\u00f6tes")],
                             [("ui/\u00e9t\u00e9.swf", payload(5, 3)), ("ui/My Mod.cfg", b"[x]\nk = v")]),
        "multi_block": tmod_case("multi", [("title", "Multi"), ("author", "a"), ("modLoader", "X"), ("tags", "a,b")],
                                 [("textures/big.png", payload(70001, 11)), ("ui/empty.swf", b""), ("ui/three.swf", b"xyz")]),
        "exact_block": tmod_case("exact", [("title", "Exact"), ("author", "a")], [("ui/a.swf", payload(32768, 5))]),
        "version3": tmod_case("v3", [("title", "V3"), ("author", "a")], [("ui/a.swf", b"1")], version=3),
    }


def write_fixtures():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    out = []
    for c in TOML_CASES:
        try:
            out.append([c, toml.dumps({"name": c, "properties": {"title": c, "my key": "v", "k.x": c}, "files": [c, "b"]})])
        except Exception as e:
            out.append([c, f"ERR {type(e).__name__}: {e}"])
    (FIXTURES / "toml_cases.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    paths = {p: _normalize_internal_path(p) for p in PATH_CASES}
    (FIXTURES / "internal_paths.json").write_text(json.dumps(paths, indent=1), encoding="utf-8")

    built = {}
    for key, mod in build_cases().items():
        data = mod.compile_tmod()
        if len(data) < 4096:  # the big cases are compared by md5 only
            (FIXTURES / f"{key}.tmod").write_bytes(data)
        built[key] = {"md5": hashlib.md5(data).hexdigest(), "metadata": mod.metadata,
                      "properties": [[p.name, p.value] for p in mod.properties]}
    (FIXTURES / "built.json").write_text(json.dumps(built, indent=1), encoding="utf-8")

    # A header written by the old character-counting builds, and how Python reads it.
    legacy = bytes(legacy_char_header(build_cases()["unicode"]))
    (FIXTURES / "legacy_char_lengths.tmod").write_bytes(legacy)
    read = TMod.read_bytes(Path("legacy.tmod"), legacy)
    built["legacy_read"] = describe(read, read.hash)
    (FIXTURES / "built.json").write_text(json.dumps(built, indent=1), encoding="utf-8")

    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("UI/Zipped.SWF", b"zipped")
        z.writestr("folder/", b"")
        z.writestr("ui\\back.swf", b"back")
        z.writestr("\u00e9t\u00e9.swf", b"utf8")
    (FIXTURES / "zipped.zip").write_bytes(zbuf.getvalue())
    zmod = ZMod.read_bytes(Path("Zipped Mod.zip"), io.BytesIO(zbuf.getvalue()))
    built["zip_read"] = describe(zmod, zmod.hash)
    for key in ("simple", "unicode", "version3"):
        data = (FIXTURES / f"{key}.tmod").read_bytes()
        mod = TMod.read_bytes(Path(f"{key}.tmod"), data)
        built[f"{key}_read"] = describe(mod, mod.hash)

    # The modpack container the Mod Manager rebuilds (case-preserved inner names).
    from backend.mod_manager.modpacks import _rebuild_tpack, _tpack_file_names
    inner = [("Simple Mod.tmod", (FIXTURES / "simple.tmod").read_bytes()), ("Café.tmod", (FIXTURES / "unicode.tmod").read_bytes())]
    tpack = bytes(_rebuild_tpack(2, [("title", "Pack"), ("author", "me")], inner))
    built["tpack"] = {"md5": hashlib.md5(tpack).hexdigest(), "names": _tpack_file_names(tpack)}
    (FIXTURES / "built.json").write_text(json.dumps(built, indent=1), encoding="utf-8")
    print("wrote", FIXTURES)


def legacy_char_header(mod):
    """What builds before the UTF-8 fix wrote: `len(str)` lengths, UTF-8 bytes."""
    from binary_reader import BinaryReader
    from utils.functions import chunks, write_leb128
    import zlib
    mod.reorder_files()
    mod.add_property("modLoader", "BTT")
    props = BinaryReader(bytearray())
    for p in mod.properties:
        props.write_bytes(write_leb128(len(p.name)))
        props.write_bytes(p.name.encode("utf-8"))
        props.write_bytes(write_leb128(len(p.value)))
        props.write_bytes(p.value.encode("utf-8"))
    files = bytearray()
    for f in mod.files:
        path = f.trove_path
        files += bytes([len(path)]) + path.encode("utf-8") + write_leb128(f.index) + write_leb128(f.offset if f.data else 0) \
            + write_leb128(f.size) + write_leb128(f.checksum)
    body = b"".join(bytes(f.padded_data) for f in mod.files)
    c = zlib.compressobj(level=0, strategy=0, wbits=zlib.MAX_WBITS)
    stream = b"".join(c.compress(ch) for ch in chunks(body, 32768)) + c.flush(zlib.Z_SYNC_FLUSH)
    header = bytearray(8) + (mod.version).to_bytes(2, "little") + len(mod.properties).to_bytes(2, "little") + props.buffer() + files
    header[:8] = len(header).to_bytes(8, "little")
    return header + stream


def describe(mod, hash_value):
    files = []
    for f in mod.files:
        data = bytes(f.data)
        files.append({"path": f.trove_path, "index": f.index, "offset": f.offset, "size": f.size,
                      "checksum": f.checksum, "md5": hashlib.md5(data).hexdigest()})
    return {"version": mod.version, "properties": [[p.name, p.value] for p in mod.properties], "files": files,
            "hash": hash_value, "name": mod.name, "tags": mod.tags, "subtype": mod.subtype,
            "preview": mod.preview_path, "config": mod.config_path, "is_ui": bool(mod.is_ui_mod),
            "content_files": mod.content_files, "image_md5": hashlib.md5(mod.image.encode()).hexdigest()}


def dump_real(mods_dir, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {}
    for path in sorted(Path(mods_dir).iterdir()):
        name = path.name
        try:
            data = path.read_bytes()
            if ".zip" in name:
                mod = ZMod.read_bytes(path, io.BytesIO(data))
                report[name] = {"zip": describe(mod, mod.hash)}
                continue
            full = TMod.read_bytes(path, data)
            entry = {"full": describe(full, full.hash)}
            header = data[:int.from_bytes(data[:8], "little")]
            partial = TMod.read_bytes(path, header, partial=True)
            entry["partial_hash"] = partial.hash
            full.reset_cache()
            rebuilt = full.compile_tmod()
            (out_dir / (name + ".rebuilt")).write_bytes(rebuilt)
            entry["rebuilt_md5"] = hashlib.md5(rebuilt).hexdigest()
            report[name] = entry
        except Exception as e:
            report[name] = {"error": f"{type(e).__name__}: {e}"}
    (out_dir / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("wrote", len(report), "mods to", out_dir)


def snapshot_tree(root):
    root = Path(root)
    if not root.exists():
        return {}
    return {p.relative_to(root).as_posix(): hashlib.md5(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def dump_list(mods_src, side_dir):
    """Copy <mods_src> into <side_dir>/game/mods, list it like the Mod Manager does
    (header-only, fixing names and configs), and record the result."""
    import shutil
    from models.trove.mod import TroveModList
    from utils.registry import TroveGamePath
    side = Path(side_dir)
    shutil.rmtree(side, ignore_errors=True)
    game = side / "game"
    shutil.copytree(mods_src, game / "mods")
    os.environ["APPDATA"] = str(side / "appdata")
    mods = TroveModList(TroveGamePath(game), partial=True, fix_names=True, fix_configs=True)
    rows = []
    for mod in mods:
        rows.append({"name": mod.name, "author": mod.author, "version": mod.mod_version, "enabled": mod.enabled,
                     "path": mod.mod_path.relative_to(game).as_posix(), "hash": mod.hash,
                     "image_md5": hashlib.md5(mod.image.encode()).hexdigest(), "has_conflicts": mod.has_conflicts,
                     "conflicts": sorted(c.name or "" for c in mod.conflicts), "wrong_name": mod.has_wrong_name})
    result = {"mods": rows, "read_only_configs": mods.read_only_configs,
              "mods_dir": sorted(p.name for p in (game / "mods").iterdir()),
              "mod_cfgs": snapshot_tree(side / "appdata" / "Trove" / "ModCfgs")}
    (side / "list.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print("listed", len(rows), "mods into", side)


if __name__ == "__main__":
    if sys.argv[1:2] == ["fixtures"]:
        write_fixtures()
    elif sys.argv[1:2] == ["real"]:
        dump_real(sys.argv[2], sys.argv[3])
    elif sys.argv[1:2] == ["list"]:
        dump_list(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
