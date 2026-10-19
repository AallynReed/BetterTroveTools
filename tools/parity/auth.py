"""Parity check: core/src/auth vs backend/auth.py, utils/secure_store.py, utils/legacy_launcher_cleanup.py.

Runs one scripted session through Python and through the Rust harness
(`auth::tests::parity_harness`) against a local fake API, then diffs the endpoint results,
the external-request log, every request the fake server saw, and the DPAPI store in both
directions. Never touches the real API or the real app data (APPDATA is a temp dir).

    .venv\\Scripts\\python.exe tools\\parity\\auth.py
"""
import base64
import itertools
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
REAL_APPDATA = os.environ.get("APPDATA", "")
FIXTURES = ROOT / "core" / "tests" / "fixtures" / "auth"

BOUNDARY = re.compile(rb"[0-9a-f]{32}")
LOG = []


def _reply(status, body):
    if body is None:
        return status, b""
    if isinstance(body, bytes):
        return status, body
    return status, json.dumps(body).encode()


def route(method, path, auth, body):
    token = auth[len("Bearer "):] if auth.startswith("Bearer ") else None
    if path == "/v1/site-auth/oauth/exchange":
        code = (body or {}).get("code")
        return {
            "good": (200, {"access_token": "A1", "refresh_token": "R1"}),
            "nome": (200, {"access_token": "AX", "refresh_token": "RX"}),
            "list": (200, [1, 2]),
        }.get(code, (400, {"detail": "bad code"}))
    if path == "/v1/site-auth/refresh":
        rt = (body or {}).get("refresh_token")
        return {
            "R1": (200, {"access_token": "A2", "refresh_token": "R2"}),
            "R2": (200, {"access_token": "A3", "refresh_token": "R3"}),
        }.get(rt, (401, {"detail": "expired"}))
    if path == "/v1/site-auth/logout":
        return 204, None
    if path == "/v1/site-auth/me":
        return {
            "A2": (200, {"id": 1, "username": "tester", "display": "Tëst ✓"}),
            "A3": (200, b"<html>not json</html>"),
            "AX": (503, b"down"),
        }.get(token, (401, {"detail": "expired"}))
    if token == "A2" and path == "/v1/giveaways/mine":
        return 401, {"detail": "expired"}
    if token not in ("A2", "A3", "PyA"):
        return 401, {"detail": "expired"}
    if method == "DELETE":
        return 204, None
    table = {
        ("GET", "/v1/mods/hub/me/projects"): (200, [{"handle": "h", "slug": "s"}]),
        ("GET", "/v1/modpacks/hub/me/projects"): (200, {"items": [], "total": 0}),
        ("POST", "/v1/mods/hub/projects"): (201, {"echo": body}),
        ("POST", "/v1/modpacks/hub/projects"): (409, {"detail": "", "error": "Slug taken"}),
        ("PATCH", "/v1/modpacks/hub/projects/h/s"): (422, {"detail": [{"loc": ["body", "title"], "msg": "field required"}]}),
        ("GET", "/site/mods/projects/h/s"): (200, {"title": "T", "visibility": "draft"}),
        ("GET", "/site/modpacks/projects/h/s"): (404, {"error": "Not found"}),
        ("GET", "/site/mods/projects/h/s/releases"): (500, b"<html>Internal</html>"),
        ("POST", "/v1/mods/hub/projects/h/s/releases/upload"): (200, {"id": 42}),
        ("PATCH", "/v1/mods/hub/releases/42"): (200, {"id": 42, "echo": body}),
        ("GET", "/v1/mods/hub/projects/h/s/branches"): (200, ["main", "beta"]),
        ("POST", "/v1/giveaways/7/enter"): (200, b"null"),
        ("GET", "/v1/giveaways/mine"): (200, []),
    }
    if (method, path) in table:
        return table[(method, path)]
    if path.startswith("/v1/mods?"):
        return 200, {"query": path}
    if path.endswith("/banner"):
        return 200, {"banner_url": "https://x/b.png"}
    return 200, {"echo": body, "path": path}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        ctype = self.headers.get("Content-Type") or ""
        parsed = None
        if ctype.startswith("application/json"):
            parsed = json.loads(raw)
        normalized = BOUNDARY.sub(b"BOUNDARY", raw)
        try:
            shown = normalized.decode("utf-8")
        except UnicodeDecodeError:
            shown = "b64:" + base64.b64encode(normalized).decode()
        LOG.append({
            "method": self.command,
            "path": self.path,
            "user_agent": self.headers.get("User-Agent"),
            "authorization": self.headers.get("Authorization"),
            "content_type": BOUNDARY.sub(b"BOUNDARY", ctype.encode()).decode() or None,
            "content_length": self.headers.get("Content-Length"),
            "body": shown,
        })
        status, body = _reply(*route(self.command, self.path, self.headers.get("Authorization") or "", parsed))
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status != 204:
            self.wfile.write(body)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _handle


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], ConnectionError):
            super().handle_error(request, client_address)


def script(base, release, banner):
    call = lambda name, *args: {"op": "call", "name": name, "args": list(args)}
    return [
        {"op": "bases", "api": f"{base}/v1", "site": f"{base}/site"},
        call("site_auth_me"),
        call("site_mods_list"),
        call("site_auth_complete", ""),
        call("site_auth_complete", "bad"),
        call("site_auth_begin_login"),
        call("site_auth_complete", "good"),
        call("site_auth_me"),
        {"op": "restart"},
        call("site_auth_me"),
        call("site_mods_list"),
        call("site_modpacks_list"),
        call("site_mod_create", "My Mod"),
        call("site_mod_create", "Other", None),
        call("site_modpack_create", "Pack", "public"),
        call("site_mod_update", "a b", "c|d^é", {"title": "Té"}),
        call("site_modpack_update", "h", "s", None),
        call("site_mod_delete", "h", "s"),
        call("site_modpack_delete", "h", "s"),
        call("site_mod_detail", "h", "s"),
        call("site_modpack_detail", "h", "s"),
        call("site_mod_releases", "h", "s"),
        {"op": "pick", "path": release},
        call("site_mod_release_upload", "h", "s", {"tag": " v1 ", "title": "T", "changelog": "line1\nline2", "status": None, "branch": "main"}),
        call("site_mod_release_upload", "h", "s", {"tag": "  "}),
        call("site_mod_release_upload", "h", "s", None),
        {"op": "pick", "path": banner},
        call("site_mod_banner_upload", "h", "s"),
        call("site_modpack_banner_upload", "h", "s"),
        {"op": "pick", "path": None},
        call("site_mod_release_upload", "h", "s", {"tag": "v2"}),
        call("site_mod_banner_upload", "h", "s"),
        call("site_mod_release_update", 42, {"status": "draft"}),
        call("site_mod_release_delete", 42),
        call("site_mod_collaborator_add", "h", "s", "friend"),
        call("site_mod_collaborator_remove", "h", "s", 9),
        call("site_modpack_collaborator_add", "h", "s", "friend"),
        call("site_modpack_collaborator_remove", "h", "s", "u-1"),
        call("site_modpack_variant_create", "h", "s", "beta"),
        call("site_modpack_variant_create", "h", "s", "beta2", "beta"),
        call("site_modpack_variant_update", "h", "s", "beta", "Beta!"),
        call("site_modpack_variant_delete", "h", "s", "beta"),
        call("site_modpack_set_entries", "h", "s", "beta", None),
        call("site_modpack_set_entries", "h", "s", "beta", [{"mod": "x", "branch": "main"}]),
        call("site_hub_search", "  héllo wörld/x&y  ", 20),
        call("site_hub_search", "", "15"),
        call("site_hub_search", "x"),
        call("site_hub_search", "x", "2.5"),
        call("site_hub_search", 5, 1),
        call("site_mod_branches", "h", "s"),
        call("site_giveaway_enter", 7),
        call("site_giveaway_mine"),
        call("site_giveaway_mine"),
        call("site_auth_me"),
        call("site_auth_logout"),
        call("site_auth_me"),
        call("site_auth_complete", "nome"),
        call("site_auth_complete", "list"),
        {"op": "restart"},
        {"op": "write_file", "path": "Trove/ModManagerCache/account.bin", "b64": base64.b64encode(b"not a dpapi blob").decode()},
        call("site_auth_me"),
        {"op": "exists", "path": "Trove/ModManagerCache/account.bin"},
        {"op": "write_file", "path": "Trove/TroveLauncher/glyph_pw.bin", "b64": base64.b64encode(b"secret").decode()},
        {"op": "write_file", "path": "Trove/TroveLauncher/tickets/t.json", "b64": base64.b64encode(b"{}").decode()},
        {"op": "write_file", "path": "Trove/ModManagerCache/overlay.json", "b64": base64.b64encode(b"{}").decode()},
        {"op": "purge"},
        {"op": "exists", "path": "Trove/TroveLauncher"},
        {"op": "exists", "path": "Trove/ModManagerCache/overlay.json"},
        {"op": "bases", "api": "http://127.0.0.1:9/v1", "site": "http://127.0.0.1:9/site"},
        call("site_auth_complete", "good"),
    ]


def run_python(steps, appdata):
    os.environ["APPDATA"] = appdata
    import eel
    import backend.auth as auth
    from utils import legacy_launcher_cleanup, secure_store

    js, opened, pick = [], [], [None]
    rids = itertools.count(1)

    def add_external_request(label, url):
        rid = f"r{next(rids)}"
        js.append(["add_external_request", [label, url]])
        return lambda: rid

    def remove_external_request(rid, ok):
        js.append(["remove_external_request", [{"$rid": rid}, ok]])
        return lambda: None

    def fake_pick(title, filetypes, initial_dir=None):
        if not pick[0]:
            return None, None
        path = pick[0].replace("\\", "/")
        try:
            return path, Path(path).read_bytes()
        except OSError:
            return None, None

    eel.add_external_request = add_external_request
    eel.remove_external_request = remove_external_request
    auth.webbrowser.open = lambda url, *a, **k: opened.append(url) or True
    auth._pick_file = fake_pick

    out = []
    for step in steps:
        seen = len(js)
        opened.clear()
        op = step["op"]
        result = None
        if op == "call":
            result = getattr(auth, step["name"])(*step["args"])
        elif op == "restart":
            auth._tokens, auth._user, auth._loaded = None, None, False
        elif op == "bases":
            auth.KIWI_API_BASE, auth._SITE_BASE = step["api"], step["site"]
        elif op == "pick":
            pick[0] = step["path"]
        elif op == "store_save":
            result = secure_store.save_tokens(step["tokens"])
        elif op == "store_load":
            result = secure_store.load_tokens()
        elif op == "purge":
            legacy_launcher_cleanup.purge()
        elif op == "write_file":
            target = Path(appdata) / step["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(step["b64"]))
        elif op == "exists":
            result = (Path(appdata) / step["path"]).exists()
        out.append({"result": json.loads(json.dumps(result)), "js": js[seen:], "opened": list(opened)})
    return out


def run_rust(steps, appdata, work):
    script_path, out_path = work / "rust_script.json", work / "rust_out.json"
    script_path.write_text(json.dumps(steps), encoding="utf-8")
    env = dict(os.environ, APPDATA=REAL_APPDATA, CARGO_TARGET_DIR=str(ROOT / "target" / "port-auth"),
               BTT_PARITY_SCRIPT=str(script_path), BTT_PARITY_OUT=str(out_path), BTT_PARITY_APPDATA=appdata)
    cmd = ["cargo", "test", "-q", "-p", "btt-core", "--no-default-features", "--features", "auth", "--lib", "--",
           "--ignored", "--exact", "auth::tests::parity_harness"]
    subprocess.run(cmd, cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    return json.loads(out_path.read_text(encoding="utf-8"))


def diff(label, a, b, steps, tolerate=()):
    bad = 0
    for i, (x, y) in enumerate(zip(a, b)):
        if x == y:
            continue
        if i in tolerate:
            continue
        bad += 1
        print(f"[{label}] step {i} {json.dumps(steps[i])[:120]}\n  python: {json.dumps(x)[:600]}\n  rust:   {json.dumps(y)[:600]}")
    if len(a) != len(b):
        bad += 1
        print(f"[{label}] length differs: python {len(a)} rust {len(b)}")
    return bad


def main():
    work = Path(tempfile.mkdtemp(prefix="btt-auth-parity-"))
    release = work / "pick" / "release v1.tmod"
    banner = work / "pick" / "Banner.PNG"
    release.parent.mkdir(parents=True)
    release.write_bytes(b"TMOD\x00\x01binary\xff")
    banner.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    server = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    steps = script(base, str(release), str(banner))

    py_app, rs_app = work / "py_appdata", work / "rs_appdata"
    py_app.mkdir()
    rs_app.mkdir()
    py_out = run_python(steps, str(py_app))
    py_log = list(LOG)
    LOG.clear()
    rs_out = run_rust(steps, str(rs_app), work)
    rs_log = list(LOG)

    # Transport-failure text is the HTTP client's own message; only the envelope is compared.
    last = len(steps) - 1
    for out in (py_out, rs_out):
        if out[last]["result"].get("code") == "EXCHANGE_FAILED":
            out[last]["result"]["error"] = "<transport error>"

    bad = diff("results", [s["result"] for s in py_out], [s["result"] for s in rs_out], steps)
    bad += diff("external requests", [s["js"] for s in py_out], [s["js"] for s in rs_out], steps)
    bad += diff("browser", [s["opened"] for s in py_out], [s["opened"] for s in rs_out], steps)
    for i, (x, y) in enumerate(zip(py_log, rs_log)):
        if x != y:
            bad += 1
            print(f"[server] request {i}\n  python: {x}\n  rust:   {y}")
    if len(py_log) != len(rs_log):
        bad += 1
        print(f"[server] python sent {len(py_log)} requests, rust {len(rs_log)}")

    # DPAPI store, both directions, in a shared throwaway APPDATA.
    shared = work / "shared_appdata"
    shared.mkdir()
    from utils import secure_store
    os.environ["APPDATA"] = str(shared)
    py_tokens = {"access_token": "PyA", "refresh_token": "PyR"}
    secure_store.save_tokens(py_tokens)
    loaded = run_rust([{"op": "store_load"}], str(shared), work)[0]["result"]
    if loaded != py_tokens:
        bad += 1
        print(f"[store] rust read {loaded!r} from the python blob")
    rs_tokens = {"access_token": "RsA", "refresh_token": "RéR"}
    run_rust([{"op": "store_save", "tokens": rs_tokens}], str(shared), work)
    back = secure_store.load_tokens()
    if back != rs_tokens:
        bad += 1
        print(f"[store] python read {back!r} from the rust blob")

    FIXTURES.mkdir(parents=True, exist_ok=True)
    golden = {"results": [s["result"] for s in py_out], "requests": py_log}
    text = json.dumps(golden, indent=1, ensure_ascii=False).replace(base, "http://FAKE")
    text = text.replace(str(work).replace("\\", "/"), "<work>").replace(json.dumps(str(work))[1:-1], "<work>")
    (FIXTURES / "python_session.json").write_text(text, encoding="utf-8")

    server.shutdown()
    print(f"{len(steps)} steps, {len(py_log)} requests: {'OK' if not bad else f'{bad} differences'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
