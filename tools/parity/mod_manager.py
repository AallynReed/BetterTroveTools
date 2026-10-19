"""Parity check: core/src/mod_manager vs backend/mod_manager.

    .venv\\Scripts\\python.exe tools\\parity\\mod_manager.py fixtures
    .venv\\Scripts\\python.exe tools\\parity\\mod_manager.py live [--mods PATH] [--only PREFIX]

`fixtures` records Python's answers for the pure helpers (change-note HTML, hub release
picking, install names, the blocklist predicate) in core/tests/fixtures/mod_manager,
which the Rust unit tests replay.

`live` builds two scratch installs from a copy of the real mods folder (a fake Steam
library, so one mod sits in a fake Workshop item), each with its own APPDATA holding a
copy of the real Trove.cfg, then runs the same endpoint script through Python and
through the Rust harness (`mod_manager::tests::parity_harness`) and diffs results,
page callbacks, network-log entries and the files written. Listings and lookups hit
Trovesaurus and the Kiwi API for real (read-only); installs only ever land in the
scratch folders. Steam steps run only while Steam is closed (the not-running path).
"""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
REAL_APPDATA = os.environ.get("APPDATA", "")
REAL_MODS = Path(r"C:\Program Files (x86)\Glyph\Games\Trove\Live\mods")
FIXTURES = ROOT / "core" / "tests" / "fixtures" / "mod_manager"
WORKSHOP_ITEM = "3000000001"

CALLS = []


def _record(*entry):
    CALLS.append(list(entry))


def _install_eel_stubs():
    import eel
    import gevent

    eel.add_external_request = lambda label, url: (_record("ext", label, url), (lambda: "rid"))[1]
    eel.remove_external_request = lambda rid, ok: (_record("done", ok), (lambda: None))[1]
    for name in ("receive_mods_changed", "receive_auto_mod_updates", "receive_trovesaurus_mods", "receive_install_result",
                 "receive_mods_hub_mods", "receive_mods_hub_install_result", "receive_modpacks"):
        setattr(eel, name, (lambda n: lambda *a: (_record(n, list(a)), (lambda: None))[1])(name))
    gevent.spawn = lambda fn, *a, **k: fn(*a, **k)


# --- fixtures ---------------------------------------------------------------------------

HTML_CASES = [
    "", "plain", "<p>One</p><p>Two</p>", "a<br>b<BR/>c<br />d", "<ul><li>x</li><li class='y'>y &amp; z</li></ul>",
    "&lt;tag&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66; &nbsp;nb", "&amp &lt3 &copy; &notit; &unknown; &#0; &#xD800;",
    "  spaced   out \t text \r\n\r\n next ", "<h2>Head</h2>body<div>d</div>", "\u00e9t\u00e9 <b>bold</b>",
    "line\u2028sep\x1cfs", "&AMP;&Eacute;&eacute&ampx", "<a href='x'>link</a> >> < not a tag",
]

RELEASES = [
    {"branch": "main", "published_at": "2025-01-01T00:00:00Z", "sha256": "AA", "tag": "v1.0", "title": "1.0", "changelog": " first ", "download_url": "u1", "format": ".tmod", "size": "12", "download_count": 3},
    {"branch": "main", "published_at": "2025-03-01T00:00:00Z", "sha256": "bb", "tag": "1.2", "title": "Big update", "changelog": "two", "download_url": "u2", "filename": "My Mod.TMOD"},
    {"branch": "beta", "published_at": "2025-04-01T00:00:00Z", "sha256": "cc", "tag": "", "title": "Beta 3", "download_url": None, "format": "zip", "size": None},
    {"branch": None, "published_at": None, "sha256": "dd", "title": "", "size": "1.5", "download_count": "7"},
    {"branch": "main", "published_at": "2025-03-01T00:00:00Z", "sha256": "ee", "tag": "1.2b", "title": "v1.2b"},
    "not a dict",
]


def write_fixtures():
    _install_eel_stubs()
    import requests

    from backend.mod_manager import blocklist, mod_manager as mm, mods_hub as hub, modpacks, trovesaurus as ts

    cases = []

    def case(fn, args, fn_impl):
        try:
            result = fn_impl(*args)
        except Exception as e:
            result = {"raised": f"{type(e).__name__}: {e}"}
        cases.append({"fn": fn, "args": args, "result": json.loads(json.dumps(result, default=str))})

    notes = list(HTML_CASES)
    try:
        catalog = requests.get("https://trovesaurus.com/api/mods-all", timeout=30).json()
        seen = set()
        for m in catalog:
            for f in m.get("downloads") or []:
                c = f.get("changes") or ""
                if ("<" in c or "&" in c) and c not in seen and len(c) < 600 and len(seen) < 60:
                    seen.add(c)
                    notes.append(c)
    except Exception as e:
        print("no live change notes:", e)
    for n in notes:
        case("html_to_text", [n], mm._html_to_text)

    for p in ["C:\\x\\Mod.tmod", "Mod.TMOD.DISABLED", "a/b/c.zip.disabled", ".disabled", "x.disabledd", "\u00c9.tmod.disabled", ""]:
        case("lock_key", [p], mm._lock_key)
    for h, s in [("aallyn", "x"), (" /a/ ", "/b/"), (None, "s"), ("", None), (5, "x"), ("h", "")]:
        case("mod_ref", [h, s], hub._mod_ref)
    for branch in [None, "main", "beta", "nope", ""]:
        case("latest_release", [RELEASES, branch], hub._latest_release)
    case("latest_release", [[], None], hub._latest_release)
    case("branch_variants", [RELEASES], hub._branch_variants)
    for matched in [RELEASES[0], RELEASES[1], RELEASES[2], {}, {"branch": "main"}, {"branch": "gone", "sha256": "zz", "published_at": "2024"}]:
        case("release_outdated", [matched, RELEASES], hub._release_outdated)
        case("changes_since", [matched, RELEASES], hub._changes_since)
    case("release_outdated", [RELEASES[0], []], hub._release_outdated)
    for r in RELEASES[:5] + [{"filename": "x.zip.disabled"}, {"format": "ZIP"}, {}]:
        case("release_extension", [r], hub._release_extension)
    for n in ["Good Name", ' bad<>:"/\\|?*name. ', "...", "", "tab\there", "\u00e9\u4e2d", "x\u200by", "name.."]:
        case("safe_filename", [n], hub._safe_filename)
        case("name_from_filename", [n + ".TMOD.disabled"], modpacks._name_from_filename)
        case("safe_pack_filename", ["dir/" + n], modpacks._safe_pack_filename)

    simple = (ROOT / "core" / "tests" / "fixtures" / "modfile" / "simple.tmod").read_bytes()
    b64 = base64.b64encode(simple).decode()
    for ext, release, detail in [(".tmod", {}, {}), (".zip", {"filename": "dir/Zip Mod.ZIP"}, {}), (".zip", {}, {"title": "Detail: Title"}),
                                 (".zip", {"filename": "x.tmod.disabled"}, {"title": ""}), (".tmod", {"filename": "a.tmod"}, {})]:
        case("install_name", [b64, ext, release, detail], lambda d, e, r, de: hub._install_name(base64.b64decode(d), e, r, de))
    case("install_name", [base64.b64encode(b"junk").decode(), ".tmod", {"filename": "Fallback.tmod"}, {}],
         lambda d, e, r, de: hub._install_name(base64.b64decode(d), e, r, de))

    for data in [{"downloads": [{"fileid": "3", "extra": "0"}, {"fileid": 10, "extra": 1}, {"fileid": "7"}]}, {"downloads": []}, {},
                 {"downloads": [{"fileid": "x"}]}, {"downloads": [{"fileid": 2, "extra": None}, {"fileid": 2, "format": "zip"}]}]:
        case("latest_mod_file", [data], ts._latest_mod_file)
    for args in [["C:\\G", "My Mod! (v2)", ".tmod", None], ["C:\\G", "", ".zip", None], ["C:\\G", "\u00e9t\u00e9_-x", ".tmod", None],
                 ["C:\\G", "x", ".zip", "C:\\G\\mods\\Old Name.tmod.disabled"], ["C:\\G", "x", ".tmod", "C:\\G\\mods\\noext"],
                 ["C:\\G", "x", ".tmod", "C:\\G\\mods\\a.b.zip"]]:
        case("install_target", args, lambda g, n, e, x: str(ts._install_target(g, n, e, x)))

    data = {"authors": ["7", 8], "mods": [100, "200"], "hashes": ["ABC", "def"]}
    original = blocklist._fetch
    blocklist._fetch = lambda: data
    blocked = blocklist.load()
    blocklist._fetch = original
    for m in [{"id": 100}, {"id": "200"}, {"id": 1, "author": {"ID": 7}}, {"id": 1, "author": {"ID": "8"}}, {"id": 0, "author": "7"},
              {"id": 1, "downloads": [{"hash": "abc"}]}, {"id": 1, "downloads": [{"hash": "DEF"}, "x"]}, {"id": 1, "downloads": [{"hash": None}]},
              {"id": 1.0, "author": {"ID": 0}}, {}]:
        case("blocked", [data, m], lambda d, mod: blocked(mod))

    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / "helpers.json").write_text(json.dumps(cases, indent=1), encoding="utf-8")
    print(f"wrote {len(cases)} cases to {FIXTURES / 'helpers.json'}")


# --- live run ---------------------------------------------------------------------------

def steam_running():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq steam.exe"], capture_output=True, text=True).stdout
    return "steam.exe" in out.lower()


def build_side(work, name, mods_src):
    side = work / name
    appdata = side / "appdata"
    (appdata / "Trove").mkdir(parents=True)
    real_cfg = Path(REAL_APPDATA) / "Trove" / "Trove.cfg"
    if real_cfg.exists():
        shutil.copy2(real_cfg, appdata / "Trove" / "Trove.cfg")
    lib = side / "lib"
    game = lib / "steamapps" / "common" / "Trove" / "Games" / "Trove" / "Live"
    shutil.copytree(mods_src, game / "mods")
    enabled = sorted(p for p in (game / "mods").glob("*.tmod"))
    item = lib / "steamapps" / "workshop" / "content" / "304050" / WORKSHOP_ITEM
    item.mkdir(parents=True)
    shutil.copy2(enabled[0], item / "Workshop Copy.tmod")
    shutil.copy2(enabled[1], game / "mods" / "misnamed file.tmod")
    return {"ROOT": str(side), "APPDATA": str(appdata), "GAME": str(game), "MODS": str(game / "mods"),
            "WS": str(item / "Workshop Copy.tmod")}, enabled


def build_steps(enabled, with_steam):
    names = [p.name for p in enabled]
    mod_a, mod_b, mod_x = f"<MODS>\\{names[2]}", f"<MODS>\\{names[3]}", f"<MODS>\\{names[4]}"
    hub_ref = "aallyn/zakros-ui-death-message"
    pid = "{{profile_save:data.profile.id}}"
    G = "<GAME>"
    s = []

    def call(sid, name, *args):
        s.append({"id": sid, "op": "call", "name": name, "args": list(args)})

    def op(sid, kind, **kw):
        s.append({"id": sid, "op": kind, **kw})

    call("installed", "get_installed_mods", G, False, True)
    op("installed_json", "read", path="<APPDATA>\\Trove\\ModManagerCache\\installed_mods.json")
    op("cfgs", "readdir", path="<APPDATA>\\Trove\\ModCfgs")
    op("cfg_after_list", "read", path="<APPDATA>\\Trove\\Trove.cfg")
    call("lock_a", "set_mod_update_lock", G, mod_a, True)
    call("lock_b", "set_mod_update_lock", G, mod_b + ".disabled", 1)
    call("unlock_a", "set_mod_update_lock", G, mod_a, False)
    op("locks", "read", path="<APPDATA>\\Trove\\mod_locks.json")
    call("lock_bad", "set_mod_update_lock", None, mod_a, True)
    call("toggle1", "toggle_mod", G, mod_x)
    call("toggle2", "toggle_mod", G, "{{toggle1:data.new_path}}")
    call("toggle_missing", "toggle_mod", G, "<MODS>\\nope.tmod")
    call("toggle_ws", "toggle_mod", G, "<WS>")
    op("cfg_ws_off", "read", path="<APPDATA>\\Trove\\Trove.cfg")
    call("reenable_ws", "reenable_mod", G, "<WS>")
    op("cfg_ws_on", "read", path="<APPDATA>\\Trove\\Trove.cfg")
    op("mods_after_reenable", "listdir", path="<MODS>")
    call("reenable_missing", "reenable_mod", G, "<MODS>\\nope.tmod")
    call("installed2", "get_installed_mods", G, True, False)
    op("installed2_json", "read", path="<APPDATA>\\Trove\\ModManagerCache\\installed_mods.json")
    call("delete", "delete_mod", G, mod_x)
    op("trash", "read", path="<APPDATA>\\Trove\\ModManagerCache\\trash\\deletions.json")
    call("undo", "undo_delete_mod", "{{delete:data.undo_token}}")
    call("undo_again", "undo_delete_mod", "{{delete:data.undo_token}}")
    call("delete_ws", "delete_mod", G, "<WS>")
    call("delete_out", "delete_mod", G, "<ROOT>\\outside.tmod")
    call("delete_missing", "delete_mod", G, "<MODS>\\missing.tmod")
    call("delete_dir", "delete_mod", G, "<MODS>")
    call("delete_bad", "delete_mod", G, None)
    call("fix", "fix_mod_names", G)
    op("mods_after_fix", "listdir", path="<MODS>")
    call("urls", "get_mod_urls", G)
    call("updates", "check_mod_updates", G, False)
    call("updates_force", "check_mod_updates", G, True)
    call("update_locked", "perform_mod_update", G, mod_b)
    call("update_ws", "perform_mod_update", G, "<WS>")
    call("update_first", "perform_mod_update", G, "{{updates:data.updates.$key0}}")
    call("update_missing", "perform_mod_update", G, "<MODS>\\nope.tmod")
    if with_steam:
        call("unsub_ws", "unsubscribe_workshop_mod", G, "<WS>")
    call("unsub_local", "unsubscribe_workshop_mod", G, mod_a)
    call("watch", "set_watched_install", G)
    op("tick0", "tick")
    op("touch", "write", path="<MODS>\\notes.txt", text="hello")
    op("tick1", "tick")
    op("tick2", "tick")
    op("tick3", "tick")
    call("unwatch", "set_watched_install", "")
    op("tick4", "tick")
    op("probe", "probe", game=G)

    call("ts_hot", "get_trovesaurus_mods", 1, "", "", "hot", G, "t1", False)
    call("ts_query", "get_trovesaurus_mods", 2, "zakros", "", "date_desc", G, "t2", False)
    call("ts_cat", "get_trovesaurus_mods", 1, "", "ui", "likes_desc", "", "t3", False)
    call("ts_dl", "get_trovesaurus_mods", 9999, "", "", "downloads_desc", G, "t4", True)
    call("ts_asc", "get_trovesaurus_mods", 3, "a", "", "date_asc", G, {"tok": 5}, False)
    call("ts_install", "install_trovesaurus_mod", G, "6")
    op("mods_after_ts", "listdir", path="<MODS>")
    call("ts_install_again", "install_trovesaurus_mod", G, 6)
    op("mods_after_ts2", "listdir", path="<MODS>")
    call("ts_install_missing", "install_trovesaurus_mod", G, "999999999")
    call("ts_install_nogame", "install_trovesaurus_mod", "", "6")
    call("ts_hot_installed", "get_trovesaurus_mods", 1, "Display No Clouds", "", "hot", G, "t6", False)
    call("ts_delete", "delete_trovesaurus_installed_mod", G, "6")
    call("ts_delete_again", "delete_trovesaurus_installed_mod", G, "6")
    call("ts_delete_nogame", "delete_trovesaurus_installed_mod", "", "6")
    call("ts_clear", "clear_trovesaurus_cache")
    call("mm_clear", "clear_mod_manager_cache")

    call("hub_cats", "get_mods_hub_categories")
    call("hub_list", "get_mods_hub_mods", 1, "", "", "popular", G, "h1", False)
    call("hub_query", "get_mods_hub_mods", "1", "death", "", "title", G, "h2", False)
    call("hub_page", "get_mods_hub_mods", 99, "", "", "bogus", "", "h3", False)
    call("hub_states", "get_mods_hub_install_states", G, False)
    call("hub_variants", "get_mods_hub_variants", hub_ref)
    call("hub_install", "install_mods_hub_mod_sync", G, hub_ref, None)
    op("mods_after_hub", "listdir", path="<MODS>")
    call("hub_install_cb", "install_mods_hub_mod", G, hub_ref, "main")
    call("hub_lock", "set_mod_update_lock", G, "<MODS>\\Zakros UI - Death Message.tmod", True)
    call("hub_install_locked", "install_mods_hub_mod_sync", G, hub_ref, None)
    call("hub_unlock", "set_mod_update_lock", G, "<MODS>\\Zakros UI - Death Message.tmod", False)
    call("hub_states2", "get_mods_hub_install_states", G, True)
    call("hub_delete", "delete_mods_hub_installed_mod", G, hub_ref)
    call("hub_delete_missing", "delete_mods_hub_installed_mod", G, "nobody/nothing")
    call("hub_install_nogame", "install_mods_hub_mod_sync", "", hub_ref, None)
    call("hub_variants_bad", "get_mods_hub_variants", "nobody/nothing")
    call("hub_clear", "clear_mods_hub_cache")

    call("packs", "get_modpacks", 1, "", "recent", "p1")
    call("packs_q", "get_modpacks", 1, "zakros", "title", "p2")
    call("pack_variants", "get_modpack_variants", "aallyn", "zakros-modpack")
    call("pack_variants_bad", "get_modpack_variants", "nobody", "nothing")
    call("pack_install", "install_modpack", G, "aallyn", "zakros-modpack", None)
    op("mods_after_pack", "listdir", path="<MODS>")
    op("disabled_after_pack", "listdir", path="<MODS>\\disabled")
    op("cfg_after_pack", "read", path="<APPDATA>\\Trove\\Trove.cfg")
    call("pack_install_bad", "install_modpack", G, "nobody", "nothing", "v 1/2")
    call("profile_save", "save_modpack_as_profile", "aallyn", "zakros-modpack", None, "  My Pack ", 1700000000000)
    call("profile_save_noname", "save_modpack_as_profile", "aallyn", "zakros-modpack", None, "", 1700000000005)
    call("profiles", "list_profiles")
    call("profile_rename", "rename_profile", pid, "Renamed", 1700000000001)
    call("profile_rename_empty", "rename_profile", pid, "  ", None)
    call("profile_rename_missing", "rename_profile", "nope", "x", None)
    call("profile_check", "check_profile_updates", pid)
    call("profile_update", "update_profile_file", pid, 1700000000002)
    call("profile_apply", "apply_profile", G, pid)
    op("mods_after_apply", "listdir", path="<MODS>")
    op("disabled_after_apply", "listdir", path="<MODS>\\disabled")
    op("manifest", "read", path="<APPDATA>\\Trove\\Profiles\\index.json")
    op("pick_profile", "pick", path="<APPDATA>\\Trove\\Profiles\\" + pid + ".tpack")
    call("import", "import_tpack_file", G)
    op("pick_none", "pick", path=None)
    call("import_cancel", "import_tpack_file", G)
    call("import_nogame", "import_tpack_file", "")
    call("profile_delete", "delete_profile", pid)
    call("profile_delete_again", "delete_profile", pid)
    call("profiles2", "list_profiles")
    call("profile_check_missing", "check_profile_updates", "nope")
    call("profile_apply_missing", "apply_profile", G, "nope")

    call("catalog", "get_steam_workshop_catalog", G, False)
    call("catalog_cached", "get_steam_workshop_catalog", "", False)
    call("sub_bad", "subscribe_workshop_item", "abc")
    call("sub_none", "subscribe_workshop_item", None)
    if with_steam:
        call("sub", "subscribe_workshop_item", 123)

    op("auto_update", "auto_update", game=G)
    op("takedown", "takedown", game=G)
    call("installed_final", "get_installed_mods", G, False, False)
    op("installed_final_json", "read", path="<APPDATA>\\Trove\\ModManagerCache\\installed_mods.json")
    return s


REF = re.compile(r"\{\{(\w+):([^}]+)\}\}")


def resolve(value, env, results):
    if isinstance(value, str):
        for k, v in env.items():
            value = value.replace(f"<{k}>", v)
        whole = REF.fullmatch(value)

        def lookup(sid, path):
            cur = results.get(sid)
            for part in path.split("."):
                if isinstance(cur, dict):
                    cur = next(iter(cur), None) if part == "$key0" else cur.get(part)
                else:
                    return None
            return cur

        if whole:
            return lookup(*whole.groups())
        return REF.sub(lambda m: str(lookup(*m.groups())), value)
    if isinstance(value, list):
        return [resolve(v, env, results) for v in value]
    return value


def file_op(step, path):
    p = Path(path)
    if step["op"] == "read":
        return p.read_bytes().decode("utf-8", "replace") if p.exists() else {"missing": True}
    if step["op"] == "readdir":
        return {c.name: c.read_bytes().decode("utf-8", "replace") for c in sorted(p.iterdir())} if p.exists() else {"missing": True}
    if step["op"] == "listdir":
        return sorted(c.name for c in p.iterdir()) if p.exists() else {"missing": True}
    if step["op"] == "write":
        p.write_text(step["text"], encoding="utf-8")
        return None
    raise ValueError(step["op"])


def run_python(env, steps):
    os.environ["APPDATA"] = env["APPDATA"]
    _install_eel_stubs()
    import backend.mod_manager.mod_manager as mm
    import backend.mod_manager.mod_watcher as mw
    import backend.mod_manager.mods_hub as hub
    import backend.mod_manager.modpacks as mp
    import backend.mod_manager.profiles as pr
    import backend.mod_manager.steam_catalog as sc
    import backend.mod_manager.trovesaurus as ts

    pick = {"path": None}

    class Root:
        def attributes(self, *a):
            pass

        def withdraw(self):
            pass

        def destroy(self):
            pass

    class Dialog:
        @staticmethod
        def askopenfilename(**kw):
            return pick["path"].replace("\\", "/") if pick["path"] else ""

    mp.tk = types.SimpleNamespace(Tk=Root)
    mp.filedialog = Dialog
    mw.ModWatcher._ensure_running = lambda self: None
    modules = [mm, mw, ts, sc, hub, mp, pr]
    results, out = {}, []
    for step in steps:
        seen = len(CALLS)
        started = time.perf_counter()
        result = None
        if step["op"] == "call":
            fn = next(getattr(m, step["name"]) for m in modules if hasattr(m, step["name"]))
            args = resolve(step["args"], env, results)
            try:
                result = fn(*args)
            except Exception as e:
                result = {"raised": str(e)}
        elif step["op"] == "pick":
            pick["path"] = resolve(step["path"], env, results)
        elif step["op"] == "tick":
            result = mw.watcher._tick()
        elif step["op"] == "probe":
            result = mw.probe_configs(resolve(step["game"], env, results))
        elif step["op"] == "auto_update":
            result = list(mm.auto_update_unlocked_mods(resolve(step["game"], env, results)))
        elif step["op"] == "takedown":
            result = hub.remove_taken_down_mods(resolve(step["game"], env, results))
        else:
            result = file_op(step, resolve(step["path"], env, results))
        result = json.loads(json.dumps(result))
        results[step["id"]] = result
        out.append({"result": result, "js": CALLS[seen:], "seconds": time.perf_counter() - started})
    return out


def run_rust(env, steps, work):
    target = ROOT / "target" / "port-modman"
    cmd = ["cargo", "test", "--release", "--no-run", "--message-format=json", "-p", "btt-core",
           "--no-default-features", "--features", "mod_manager", "--lib"]
    built = subprocess.run(cmd, cwd=ROOT, env=dict(os.environ, CARGO_TARGET_DIR=str(target)), check=True,
                           capture_output=True, text=True).stdout
    exe = [json.loads(l)["executable"] for l in built.splitlines() if '"executable":"' in l][-1]
    copy = work / "mm_harness.exe"
    shutil.copy2(exe, copy)
    script, out = work / "rust_script.json", work / "rust_out.json"
    script.write_text(json.dumps({"env": env, "steps": steps}), encoding="utf-8")
    run_env = dict(os.environ, APPDATA=env["APPDATA"], BTT_PARITY_SCRIPT=str(script), BTT_PARITY_OUT=str(out))
    subprocess.run([str(copy), "--ignored", "--exact", "mod_manager::tests::parity_harness", "--nocapture"],
                   cwd=work, env=run_env, check=True, stdout=subprocess.DEVNULL)
    return json.loads(out.read_text(encoding="utf-8"))


HEX = re.compile(r"(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])")
COUNTER = re.compile(r'"(downloads|download_count)": \d+')
TRASH = re.compile(r"\d{10}_<hex>")


def scrub(value, env):
    text = json.dumps(value)
    root = env["ROOT"]
    escaped = json.dumps(root)[1:-1]
    for form in (json.dumps(escaped)[1:-1], escaped, root.replace("\\", "/"), root):
        for f in (form, form.lower()):
            text = text.replace(f, "<ROOT>")
    text = HEX.sub("<hex>", text)
    # Hub download counters tick up between the two runs (each side installs).
    text = COUNTER.sub(r'"\1": "<n>"', text)
    text = TRASH.sub("<ts>_<hex>", text)
    return json.loads(text)


def normalize_js(calls):
    out = []
    for c in calls:
        if c[0] == "add_external_request":
            out.append(["ext", *c[1]])
        elif c[0] == "remove_external_request":
            out.append(["done", c[1][1]])
        elif c[0] in ("ext", "done"):
            out.append(c)
        else:
            out.append([c[0], c[1]])
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["fixtures", "live"])
    ap.add_argument("--mods", default=str(REAL_MODS))
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    if args.mode == "fixtures":
        write_fixtures()
        return

    with_steam = not steam_running()
    if not with_steam:
        print("Steam is running: skipping the Steam subscribe/unsubscribe steps")
    work = Path(tempfile.mkdtemp(prefix="btt_mm_parity_"))
    try:
        py_env, enabled = build_side(work, "py", Path(args.mods))
        rs_env, _ = build_side(work, "rs", Path(args.mods))
        steps = build_steps(enabled, with_steam)
        if args.only:
            steps = [s for s in steps if s["id"].startswith(args.only) or s["op"] != "call"]
        print(f"{len(steps)} steps; scratch in {work}")
        py_out = run_python(py_env, steps)
        rs_out = run_rust(rs_env, steps, work)
        problems = 0
        py_total = rs_total = 0.0
        for step, p, r in zip(steps, py_out, rs_out):
            pr_, rr = scrub(p["result"], py_env), scrub(r["result"], rs_env)
            pj, rj = scrub(normalize_js(p["js"]), py_env), scrub(normalize_js(r["js"]), rs_env)
            py_total += p["seconds"]
            rs_total += r["seconds"]
            same = pr_ == rr and pj == rj
            mark = "ok  " if same else "DIFF"
            print(f"{mark} {step['id']:<24} py {p['seconds']:7.3f}s  rs {r['seconds']:7.3f}s")
            if not same:
                problems += 1
                if pr_ != rr:
                    print("   python:", json.dumps(pr_)[:1500])
                    print("   rust:  ", json.dumps(rr)[:1500])
                if pj != rj:
                    print("   py js:", json.dumps(pj)[:1500])
                    print("   rs js:", json.dumps(rj)[:1500])
        print(f"\n{problems} differing steps of {len(steps)}; total python {py_total:.1f}s, rust {rs_total:.1f}s")
        (work / "py_out.json").write_text(json.dumps(py_out), encoding="utf-8")
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
        else:
            print("kept", work)


if __name__ == "__main__":
    main()
