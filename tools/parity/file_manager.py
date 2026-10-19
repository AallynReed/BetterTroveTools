"""Parity check: core/src/file_manager vs backend/modder_tools/file_manager.py.

Runs the same calls through Python and through the Rust harness
(`file_manager::tests::parity_harness`, release build) and diffs results and files:

* the real install (read-only): temp_tree.json + manifest byte for byte, a mass extract
  of a large subset (trees diffed byte for byte), the baseline cache, no-change scans
  in both directions (each side reading the other's baseline), and a full rescan;
* a writable copy of a few install folders, mutated after a baseline, to diff update
  detection (added/changed/removed, extracted files, changelog, backup, new cache);
* the small endpoints (tracking folders in storage.json, status, dialogs, errors).

Both sides get their own throwaway APPDATA; nothing is written to the game folder.

    .venv\\Scripts\\python.exe tools\\parity\\file_manager.py [--game PATH]
"""
import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
REAL_APPDATA = os.environ.get("APPDATA", "")
FIXTURES = ROOT / "core" / "tests" / "fixtures" / "file_manager"
STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?Z")
FOLDER_STAMP = re.compile(r"\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d")

PROBLEMS = []
TIMINGS = []


def problem(msg):
    PROBLEMS.append(msg)
    print("DIFF:", msg[:2000])


# --- Python side ----------------------------------------------------------------------

class PySide:
    def __init__(self, appdata):
        os.environ["APPDATA"] = str(appdata)
        import eel
        import backend.modder_tools.file_manager as fm
        self.fm = fm
        self.js = []
        self.pick = None
        eel.update_progress_ui = lambda *a: (self.js.append(["update_progress_ui", list(a)]), (lambda *b: None))[1]
        side = self

        class Root:
            def attributes(self, *a):
                pass

            def withdraw(self):
                pass

            def destroy(self):
                pass

        class Dialog:
            @staticmethod
            def askdirectory(**kw):
                return side.pick.replace("\\", "/") if side.pick else ""

            @staticmethod
            def asksaveasfilename(**kw):
                return side.pick.replace("\\", "/") if side.pick else ""

        fm.tk = types.SimpleNamespace(Tk=Root)
        fm.filedialog = Dialog

    def run(self, appdata, steps):
        os.environ["APPDATA"] = str(appdata)
        out = []
        for step in steps:
            seen = len(self.js)
            start = time.perf_counter()
            result = None
            if step["op"] == "call":
                result = getattr(self.fm, step["name"])(*step["args"])
            elif step["op"] == "pick":
                self.pick = step["path"]
            seconds = time.perf_counter() - start
            out.append({"result": json.loads(json.dumps(result)), "js": self.js[seen:], "seconds": seconds})
        return out


HARNESS = []


def harness(work):
    """Builds the release test binary once and runs a copy from the temp folder: run from
    the build tree, its file writes were ~4x slower here (per-image AV scanning)."""
    if not HARNESS:
        env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT / "target" / "port-auth"))
        cmd = ["cargo", "test", "--release", "--no-run", "--message-format=json", "-p", "btt-core",
               "--no-default-features", "--features", "file_manager", "--lib"]
        built = subprocess.run(cmd, cwd=ROOT, env=env, check=True, capture_output=True, text=True).stdout
        exe = [json.loads(l)["executable"] for l in built.splitlines() if '"executable":"' in l][-1]
        copy = work / "fm_harness.exe"
        shutil.copy2(exe, copy)
        HARNESS.append(copy)
    return HARNESS[0]


def run_rust(appdata, steps, work):
    script, out = work / "rust_script.json", work / "rust_out.json"
    script.write_text(json.dumps(steps), encoding="utf-8")
    env = dict(os.environ, APPDATA=REAL_APPDATA, BTT_PARITY_SCRIPT=str(script), BTT_PARITY_OUT=str(out),
               BTT_PARITY_APPDATA=str(appdata))
    cmd = [str(harness(work)), "--ignored", "--exact", "file_manager::tests::parity_harness"]
    subprocess.run(cmd, cwd=work, env=env, check=True, stdout=subprocess.DEVNULL)
    return json.loads(out.read_text(encoding="utf-8"))


def call(name, *args):
    return {"op": "call", "name": name, "args": list(args)}


def pick(path):
    return {"op": "pick", "path": None if path is None else str(path)}


# --- Comparison helpers ---------------------------------------------------------------

def scrub(value, roots):
    """Replace each side's root folder with a placeholder so results compare."""
    text = json.dumps(value)
    for root, tag in roots:
        native = str(root)
        forms = (json.dumps(native.replace("\\", "\\\\"))[1:-1], json.dumps(native)[1:-1], native.replace("\\", "/"), native)
        for form in forms:
            text = text.replace(form, tag)
    text = STAMP.sub("<utc>", text)
    text = FOLDER_STAMP.sub("<local>", text)
    return json.loads(text)


def compare_results(label, steps, py_out, rs_out, roots):
    for i, (p, r) in enumerate(zip(py_out, rs_out)):
        a, b = scrub(p["result"], roots), scrub(r["result"], roots)
        if a != b:
            problem(f"{label} step {i} {json.dumps(steps[i])[:200]}\n  python: {json.dumps(a)[:800]}\n  rust:   {json.dumps(b)[:800]}")


def tree_files(root):
    root = Path(root)
    return {p.relative_to(root).as_posix(): p for p in root.rglob("*") if p.is_file()}


def compare_trees(label, a, b, skip=()):
    fa, fb = tree_files(a), tree_files(b)
    fa = {k: v for k, v in fa.items() if k not in skip}
    fb = {k: v for k, v in fb.items() if k not in skip}
    if set(fa) != set(fb):
        only_a, only_b = sorted(set(fa) - set(fb)), sorted(set(fb) - set(fa))
        problem(f"{label}: file sets differ; python-only {only_a[:5]} ({len(only_a)}), rust-only {only_b[:5]} ({len(only_b)})")
    differing = [k for k in sorted(set(fa) & set(fb)) if fa[k].read_bytes() != fb[k].read_bytes()]
    if differing:
        problem(f"{label}: {len(differing)} files differ, e.g. {differing[:5]}")
    return len(fa)


def compare_cache(label, py_file, rs_file):
    """extraction_data.json: same content; byte-identical once Python's thread-completion
    key order is replaced by Rust's (deterministic) order."""
    if not (Path(py_file).exists() and Path(rs_file).exists()):
        problem(f"{label}: missing (python {Path(py_file).exists()}, rust {Path(rs_file).exists()})")
        return
    praw, rraw = Path(py_file).read_bytes(), Path(rs_file).read_bytes()
    if (b"\r\n" in praw) != (b"\r\n" in rraw):
        problem(f"{label}: line endings differ")
    p, r = json.loads(praw), json.loads(rraw)
    for d in (p, r):
        d["last_scan_date"] = "<utc>"
    if p != r:
        for key in ("game_path", "archives", "files", "stats"):
            if p.get(key) != r.get(key):
                pk, rk = p.get(key), r.get(key)
                if isinstance(pk, dict) and isinstance(rk, dict):
                    diff = [k for k in set(pk) | set(rk) if pk.get(k) != rk.get(k)]
                    problem(f"{label}: '{key}' differs at {len(diff)} keys, e.g. {sorted(diff)[:3]}")
                else:
                    problem(f"{label}: '{key}' differs: {pk!r} vs {rk!r}")
        return
    if list(p["stats"]) != list(r["stats"]):
        problem(f"{label}: stats key order differs")
    reordered = {k: p[k] for k in r}
    for key in ("archives", "files"):
        reordered[key] = {k: p[key][k] for k in r[key]}
    rebuilt = json.dumps(reordered, indent=4).replace("\n", "\r\n" if b"\r\n" in rraw else "\n").encode()
    rs_text = STAMP.sub("<utc>", rraw.decode()).encode()
    if rebuilt != rs_text:
        problem(f"{label}: bytes differ after reordering")


def timing(label, py_out, rs_out):
    p, r = sum(s["seconds"] for s in py_out), sum(s["seconds"] for s in rs_out)
    TIMINGS.append((label, p, r))
    print(f"  {label}: python {p:.2f}s, rust {r:.2f}s")


def progress_summary(out):
    calls = [c[1] for s in out for c in s["js"] if c[0] == "update_progress_ui"]
    return {"count": len(calls), "last": calls[-1][:2] if calls else None,
            "phases": sorted({c[3] for c in calls}), "labels": sorted({str(c[2]) for c in calls})}


def compare_progress(label, py_out, rs_out, roots):
    a, b = scrub(progress_summary(py_out), roots), scrub(progress_summary(rs_out), roots)
    if a["count"] != b["count"] or a["phases"] != b["phases"] or a["labels"] != b["labels"]:
        problem(f"{label} progress: python {json.dumps(a)[:300]} rust {json.dumps(b)[:300]}")


# --- Synthetic install ----------------------------------------------------------------

def uleb(value):
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def read_index(path):
    data, pos, entries = path.read_bytes(), 0, []

    def rd(pos):
        result = shift = 0
        while True:
            b = data[pos]
            pos += 1
            result |= (b & 0x7F) << shift
            if not b & 0x80:
                return result & 0xFFFFFFFF, pos
            shift += 7

    while pos < len(data):
        n, pos = rd(pos)
        name = data[pos:pos + n].split(b"\0", 1)[0].decode()
        pos += n
        vals = []
        for _ in range(4):
            v, pos = rd(pos)
            vals.append(v)
        entries.append([name] + vals)
    return entries


def write_pack(folder, files):
    """files: [(name, bytes)] -> index.tfi + archive0.tfa (the only archive)."""
    index, blob = bytearray(), bytearray()
    for name, data in files:
        raw = name.encode()
        index += uleb(len(raw)) + raw + uleb(0) + uleb(len(blob)) + uleb(len(data)) + uleb(0)
        blob += data
    for old in folder.glob("*.tfa"):
        old.unlink()
    (folder / "index.tfi").write_bytes(bytes(index))
    (folder / "archive0.tfa").write_bytes(zlib.compress(bytes(blob)))


def unpack(folder):
    entries = read_index(folder / "index.tfi")
    contents = {}
    for e in entries:
        if e[1] not in contents:
            contents[e[1]] = zlib.decompressobj().decompress((folder / f"archive{e[1]}.tfa").read_bytes())
    return [(e[0], contents[e[1]][e[2]:e[2] + e[3]]) for e in entries]


def single_archive_dirs(game, prefix, limit):
    found = []
    for tfi in sorted((game / prefix).rglob("index.tfi")):
        tfas = list(tfi.parent.glob("*.tfa"))
        if [t.name for t in tfas] == ["archive0.tfa"] and 3 <= len(read_index(tfi)) <= 200:
            found.append(tfi.parent)
            if len(found) >= limit:
                break
    return found


# --- Scenarios ------------------------------------------------------------------------

def scenario_real_install(py, game, work):
    print("Real install (read-only):", game)
    roots = [(work / "py", "<SIDE>"), (work / "rs", "<SIDE>")]
    py_app, rs_app = work / "py" / "appdata", work / "rs" / "appdata"
    for d in (py_app, rs_app):
        d.mkdir(parents=True)
    slashed = str(game).replace("\\", "/") + "/"

    steps = [call("load_entire_game_tree", str(game), True), call("load_entire_game_tree", str(game)), call("load_entire_game_tree", slashed)]
    p = py.run(py_app, steps)
    r = run_rust(rs_app, steps, work)
    compare_results("tree", steps, p, r, roots)
    timing("load_entire_game_tree (build)", p[:1], r[:1])
    timing("load_entire_game_tree (cached)", p[1:2], r[1:2])
    cache_py, cache_rs = py_app / "Trove" / "ModManagerCache", rs_app / "Trove" / "ModManagerCache"
    for name in ("temp_tree.json", "temp_tree_manifest.json"):
        a, b = (cache_py / name).read_bytes(), (cache_rs / name).read_bytes()
        print(f"  {name}: {len(a)} bytes, identical={a == b}")
        if a != b:
            problem(f"{name} differs")

    # Rust reuses the tree Python cached (same manifest and signature).
    cross = work / "rs" / "appdata_cross"
    shutil.copytree(cache_py, cross / "Trove" / "ModManagerCache")
    out = run_rust(cross, [call("load_entire_game_tree", str(game))], work)
    if not out[0]["result"].get("from_cache"):
        problem(f"rust did not reuse python's cached tree: {out[0]['result']}")

    # Mass extract: every file outside the four biggest folders plus a sample of the rest.
    tree = json.loads((cache_py / "temp_tree.json").read_text(encoding="utf-8"))
    everything = []

    def walk(node, parts):
        for f in node["files"]:
            everything.append({"tfi": f["tfi_parent"], "archive": f["archive_index"], "offset": f["offset"],
                               "size": f["size"], "filepath": "/".join(parts + [f["name"]])})
        for name, child in node["children"].items():
            walk(child, parts + [name])

    walk(tree, [])
    rng = random.Random(7)
    heavy = ("audio/", "blueprints/", "models/", "textures/")
    chosen = [f for f in everything if not f["filepath"].startswith(heavy) or rng.random() < 0.05]
    chosen.sort(key=lambda f: (f["tfi"].lower(), f["archive"]))
    total_bytes = sum(f["size"] for f in chosen)
    print(f"  mass extract: {len(chosen)} of {len(everything)} files, {total_bytes / 1e6:.0f} MB")
    py_dest, rs_dest = work / "py" / "extract", work / "rs" / "extract"
    steps = [call("mass_extract_files", str(py_dest), chosen)]
    p = py.run(py_app, steps)
    steps_rs = [call("mass_extract_files", str(rs_dest), chosen)]
    r = run_rust(rs_app, steps_rs, work)
    compare_results("mass extract", steps, p, r, roots)
    compare_progress("mass extract", p, r, roots)
    timing("mass_extract_files", p, r)
    n = compare_trees("mass extract tree", py_dest, rs_dest)
    print(f"  extracted trees compared: {n} files")
    shutil.rmtree(py_dest, ignore_errors=True)
    shutil.rmtree(rs_dest, ignore_errors=True)

    # Baseline, then a no-change scan of each side's baseline by the other side.
    py_track, rs_track = work / "py" / "track", work / "rs" / "track"
    py_track.mkdir()
    rs_track.mkdir()
    p = py.run(py_app, [call("build_baseline_cache", str(game), str(py_track))])
    r = run_rust(rs_app, [call("build_baseline_cache", str(game), str(rs_track))], work)
    compare_results("baseline", [call("build_baseline_cache")], p, r, roots)
    compare_progress("baseline", p, r, roots)
    timing("build_baseline_cache", p, r)
    compare_cache("baseline extraction_data.json", py_track / "extraction_data.json", rs_track / "extraction_data.json")

    py_reads_rs, rs_reads_py = work / "py" / "track_x", work / "rs" / "track_x"
    shutil.copytree(rs_track, py_reads_rs)
    shutil.copytree(py_track, rs_reads_py)
    p = py.run(py_app, [call("scan_and_extract_updates", str(game), str(py_reads_rs), False)])
    r = run_rust(rs_app, [call("scan_and_extract_updates", str(game), str(rs_reads_py), False)], work)
    compare_results("no-change scan (cross baselines)", [call("scan")], p, r, roots)
    print(f"  no-change scan: python {p[0]['result'].get('details')} rust {r[0]['result'].get('details')}")
    timing("scan_and_extract_updates (no changes)", p, r)
    compare_cache("no-change scan extraction_data.json", py_reads_rs / "extraction_data.json", rs_reads_py / "extraction_data.json")

    p = py.run(py_app, [call("scan_and_extract_updates", str(game), str(py_track), False, True)])
    r = run_rust(rs_app, [call("scan_and_extract_updates", str(game), str(rs_track), False, True)], work)
    compare_results("full rescan", [call("scan")], p, r, roots)
    timing("scan_and_extract_updates (full rescan)", p, r)
    compare_cache("full rescan extraction_data.json", py_track / "extraction_data.json", rs_track / "extraction_data.json")


def scenario_updates(py, game, work):
    print("Update detection on a mutated copy")
    base = work / "upd"
    fake = base / "install"
    dirs = single_archive_dirs(game, "ui", 3) + single_archive_dirs(game, "blueprints", 2) + single_archive_dirs(game, "languages", 1)
    for d in dirs:
        shutil.copytree(d, fake / d.relative_to(game), dirs_exist_ok=True)
    print("  copied", [d.relative_to(game).as_posix() for d in dirs])
    track = base / "track_baseline"
    track.mkdir(parents=True)
    py_app, rs_app = work / "py" / "appdata", work / "rs" / "appdata"
    py.run(py_app, [call("build_baseline_cache", str(fake), str(track))])
    for name in ("py_track", "rs_track", "py_cat", "rs_cat"):
        shutil.copytree(track, base / name)

    # Mutate: drop/change/add files in one folder, rewrite only the index of another,
    # touch an archive of a third (same bytes, new mtime), add a .blueprint to a fourth.
    a, b, c, d = dirs[0], dirs[1], dirs[2], dirs[3]
    fa = fake / a.relative_to(game)
    files = unpack(fa)
    files = files[1:]
    files[0] = (files[0][0], files[0][1] + b"-changed")
    files.append(("parity\\added file.png", b"new bytes"))
    write_pack(fa, files)
    fb = fake / b.relative_to(game)
    entries = read_index(fb / "index.tfi")
    raw = bytearray()
    for name, arc, off, size, h in reversed(entries):
        raw += uleb(len(name.encode())) + name.encode() + uleb(arc) + uleb(off) + uleb(size) + uleb(h)
    (fb / "index.tfi").write_bytes(bytes(raw))
    fc = fake / c.relative_to(game) / "archive0.tfa"
    st = fc.stat()
    os.utime(fc, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    fd = fake / d.relative_to(game)
    write_pack(fd, unpack(fd) + [("parity_new_item_a_b_c_d.blueprint", b"BP")])

    roots = [(base / "py_track", "<TRACK>"), (base / "rs_track", "<TRACK>")]
    p = py.run(py_app, [call("scan_and_extract_updates", str(fake), str(base / "py_track"), False)])
    r = run_rust(rs_app, [call("scan_and_extract_updates", str(fake), str(base / "rs_track"), False)], work)
    compare_results("update scan", [call("scan")], p, r, roots)
    compare_progress("update scan", p, r, [(fake, "<GAME>")])
    print(f"  python {p[0]['result'].get('details')}\n  rust   {r[0]['result'].get('details')}")
    compare_cache("update scan extraction_data.json", base / "py_track" / "extraction_data.json", base / "rs_track" / "extraction_data.json")
    py_folder = Path(p[0]["result"]["details"]["folder"])
    rs_folder = Path(r[0]["result"]["details"]["folder"])
    n = compare_trees("update folder", py_folder, rs_folder, skip=("changelog.txt",))
    print(f"  update folders compared: {n} files")

    def changelog(folder):
        lines = (folder / "changelog.txt").read_bytes().decode().split("\r\n")
        return [l for l in lines if not l.startswith(("Trove Update Scan - ", "Time Elapsed: "))]

    if changelog(py_folder) != changelog(rs_folder):
        problem(f"changelog differs:\n{changelog(py_folder)}\n{changelog(rs_folder)}")
    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / "update_changelog.txt").write_text("\n".join(changelog(py_folder)).replace(str(fake), "<FAKE>"), encoding="utf-8")

    # Catalog mode with no game exe: both fail spawning the tool, after extracting.
    roots = [(base / "py_cat", "<TRACK>"), (base / "rs_cat", "<TRACK>")]
    p = py.run(py_app, [call("scan_and_extract_updates", str(fake), str(base / "py_cat"), True)])
    r = run_rust(rs_app, [call("scan_and_extract_updates", str(fake), str(base / "rs_cat"), True)], work)
    compare_results("catalog without exe", [call("scan")], p, r, roots)
    print(f"  catalog: python {p[0]['result'].get('error')!r} rust {r[0]['result'].get('error')!r}")
    return fake


def scenario_endpoints(py, game, fake, work):
    print("Small endpoints")
    out_steps = {}
    for side in ("py", "rs"):
        s = work / "ep" / side
        (s / "appdata").mkdir(parents=True)
        (s / "exists").mkdir()
        (s / "track_bad").mkdir()
        (s / "track_bad" / "extraction_data.json").write_text("{bad", encoding="utf-8")
        (s / "track_list").mkdir()
        (s / "track_list" / "extraction_data.json").write_text("[1]", encoding="utf-8")
        (s / "track_ok").mkdir()
        (s / "track_ok" / "extraction_data.json").write_text(json.dumps({"last_scan_date": "x", "game_path": None}), encoding="utf-8")
        tfi = next(fake.rglob("index.tfi"))
        first = read_index(tfi)[0]
        out_steps[side] = [
            call("get_tracking_directories"),
            call("save_tracking_directory", "A", str(s / "exists").replace("\\", "/")),
            call("save_tracking_directory", "B", str(s / "missing")),
            call("save_tracking_directory", "A2", str(s / "exists").replace("\\", "/")),
            call("set_last_tracking_directory", str(s / "missing")),
            call("get_tracking_directories"),
            call("get_tracking_status", str(s / "nope")),
            call("get_tracking_status", str(s / "track_bad")),
            call("get_tracking_status", str(s / "track_list")),
            call("get_tracking_status", str(s / "track_ok")),
            call("get_tracking_status", None),
            call("cancel_file_manager_operation", "bogus"),
            call("cancel_file_manager_operation", None),
            call("cancel_file_manager_operation", "scan_updates"),
            call("open_path_in_explorer", ""),
            call("open_path_in_explorer", "   "),
            call("open_path_in_explorer", str(s / "not here")),
            pick(None),
            call("browse_for_game_dir"),
            call("browse_for_folder"),
            call("ask_extraction_directory"),
            call("select_tracking_directory"),
            call("extract_file_to_disk", str(tfi), first[1], first[2], first[3], "x.bin"),
            pick(game),
            call("browse_for_game_dir"),
            pick(s / "exists"),
            call("browse_for_game_dir"),
            call("browse_for_folder", "Pick one"),
            call("browse_for_folder", ""),
            call("ask_extraction_directory"),
            call("select_tracking_directory"),
            pick(s / "saved.bin"),
            call("extract_file_to_disk", str(tfi), first[1], first[2], first[3], "x.bin"),
            call("extract_file_to_disk", str(tfi), first[1], 10**9, 4, "x.bin"),
            call("extract_file_to_disk", str(tfi), first[1], first[2], 10**9, "x.bin"),
            call("extract_file_to_disk", str(tfi), 77, 0, 1, "x.bin"),
            call("get_detected_game_paths"),
            call("get_detected_game_paths", True),
            call("load_entire_game_tree", str(s / "no such game")),
            call("load_entire_game_tree", None),
            call("mass_extract_files", str(s / "out"), [{"tfi": str(tfi), "archive": 77, "offset": 0, "size": 1, "filepath": "a/b"}]),
            call("mass_extract_files", str(s / "out"), [{"archive": 0}]),
            call("mass_extract_files", str(s / "out"), None),
            call("build_baseline_cache", str(fake), str(s / "no track dir")),
            call("scan_and_extract_updates", str(fake), str(s / "exists")),
        ]
    p = py.run(work / "ep" / "py" / "appdata", out_steps["py"])
    r = run_rust(work / "ep" / "rs" / "appdata", out_steps["rs"], work)
    roots = [(work / "ep" / "py", "<SIDE>"), (work / "ep" / "rs", "<SIDE>")]
    compare_results("endpoints", out_steps["py"], p, r, roots)
    for side in ("py", "rs"):
        saved = work / "ep" / side / "saved.bin"
        out_steps[side + "_saved"] = saved.read_bytes() if saved.exists() else None
    if out_steps["py_saved"] != out_steps["rs_saved"]:
        problem("extract_file_to_disk wrote different bytes")
    storage = {}
    for side in ("py", "rs"):
        raw = (work / "ep" / side / "appdata" / "Trove" / "ModManagerCache" / "storage.json").read_bytes()
        storage[side] = (b"\r\n" in raw, scrub(json.loads(raw), roots))
    if storage["py"][1] != storage["rs"][1]:
        problem(f"storage.json differs: {storage}")
    if storage["py"][0] != storage["rs"][0]:
        print(f"  note: storage.json line endings differ (python CRLF={storage['py'][0]}, rust CRLF={storage['rs'][0]}); written by crate::storage")
    FIXTURES.mkdir(parents=True, exist_ok=True)
    golden_roots = roots + [(fake, "<FAKE>"), (game, "<GAME>")]
    golden = [{"call": s.get("name", s["op"]), "result": scrub(x["result"], golden_roots)} for s, x in zip(out_steps["py"], p)]
    (FIXTURES / "python_endpoints.json").write_text(json.dumps(golden, indent=1), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", default=r"C:\Program Files (x86)\Glyph\Games\Trove\Live")
    parser.add_argument("--skip-real", action="store_true", help="skip the real-install scenario")
    args = parser.parse_args()
    game = Path(args.game)
    work = Path(tempfile.mkdtemp(prefix="btt-fm-parity-"))
    print("work dir", work)
    (work / "py").mkdir()
    (work / "rs").mkdir()
    py = PySide(work / "py" / "appdata")
    if not args.skip_real:
        scenario_real_install(py, game, work)
    else:
        for side in ("py", "rs"):
            (work / side / "appdata").mkdir(parents=True, exist_ok=True)
    fake = scenario_updates(py, game, work)
    scenario_endpoints(py, game, fake, work)
    print("\nTimings (wall clock):")
    for label, p, r in TIMINGS:
        print(f"  {label:42s} python {p:7.2f}s  rust {r:7.2f}s  x{p / r if r else float('inf'):.1f}")
    print(f"\n{'OK' if not PROBLEMS else f'{len(PROBLEMS)} differences'}")
    shutil.rmtree(work, ignore_errors=True)
    sys.exit(1 if PROBLEMS else 0)


if __name__ == "__main__":
    main()
