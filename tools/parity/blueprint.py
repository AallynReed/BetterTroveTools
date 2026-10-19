"""Parity cases for the Rust Blueprint Editor port (core/src/blueprint).

    python tools/parity/blueprint.py fixtures            # small golden cases -> core/tests/fixtures/blueprint
    python tools/parity/blueprint.py install <out_dir>   # real-install cases for the #[ignore] test
    python tools/parity/blueprint.py sweep <file> <n>    # engine hashes for n real blueprints
    python tools/parity/blueprint.py mods <file>         # the install's mods, unpacked and rebuilt

Every case is a request sent through bottle's own WSGI app (so multipart parsing, routing
and error pages are the real ones) and the response it gave. APPDATA points at a scratch
dir and SOURCE_DATE_EPOCH pins zip timestamps; the game install is only ever read.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import random
import struct
import sys
import tempfile
import time
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EPOCH = "1700000000"
BOUNDARY = "----WebKitFormBoundaryKiwiParity7f3a"
KEEP = {"content-type", "content-disposition", "cache-control", "x-kiwi-summary", "x-kiwi-notes",
        "x-kiwi-recoloured", "x-kiwi-rematerialised", "x-kiwi-ignored"}


def setup(appdata: Path):
    os.environ["APPDATA"] = str(appdata)
    os.environ["SOURCE_DATE_EPOCH"] = EPOCH
    sys.path.insert(0, str(ROOT))
    os.chdir(ROOT)
    import bottle
    import backend.modder_tools.blueprint_editor  # noqa: F401  (registers the routes)
    return bottle.default_app()


def multipart(fields) -> tuple[bytes, str]:
    out = bytearray()
    for name, value in fields:
        out += f"--{BOUNDARY}\r\n".encode()
        if isinstance(value, tuple):
            fname, data = value
            out += (f'Content-Disposition: form-data; name="{name}"; filename="{fname}"\r\n'
                    f"Content-Type: application/octet-stream\r\n\r\n").encode()
            out += data
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode() + value.encode()
        out += b"\r\n"
    out += f"--{BOUNDARY}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={BOUNDARY}"


class Recorder:
    def __init__(self, app, out: Path, big: int, timed: bool = False):
        self.app, self.out, self.big, self.timed = app, out, big, timed
        self.cases: list[dict] = []
        out.mkdir(parents=True, exist_ok=True)

    def _blob(self, kind: str, data: bytes) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        if len(data) > self.big and kind == "res":
            return {"sha256": digest, "len": len(data)}
        name = f"{kind}_{digest[:16]}.bin"
        if not (self.out / name).exists():
            (self.out / name).write_bytes(data)
        return {"file": name}

    def call(self, name, method="POST", path="/", query="", fields=None, body=b"", content_type="", pad=None):
        """`pad=(byte, count)` replaces a `b"<PAD>"` marker in the body, so a huge upload
        is stored as its two ends."""
        if fields is not None:
            body, content_type = multipart(fields)
        head = tail = None
        if pad is not None:
            head, tail = body.split(b"<PAD>")
            body = head + bytes([pad[0]]) * pad[1] + tail
        environ = {
            "REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": query,
            "CONTENT_TYPE": content_type, "CONTENT_LENGTH": str(len(body)),
            "wsgi.input": io.BytesIO(body), "wsgi.errors": io.StringIO(), "wsgi.url_scheme": "http",
            "SERVER_NAME": "localhost", "SERVER_PORT": "8000", "SERVER_PROTOCOL": "HTTP/1.1",
        }
        seen = {}

        def start_response(status, headers, exc_info=None):
            seen["status"], seen["headers"] = status, headers

        t = time.perf_counter()
        result = self.app(environ, start_response)
        data = b"".join(result)
        if hasattr(result, "close"):
            result.close()
        elapsed = time.perf_counter() - t
        headers = {k: v for k, v in seen["headers"] if k.lower() in KEEP}
        case = {"name": name, "method": method, "path": path, "query": query, "content_type": content_type,
                "status": int(seen["status"].split()[0]), "headers": headers,
                # bottle's own error pages (500s, multipart errors) are HTML; only the status is compared.
                "loose": headers.get("Content-Type", "").startswith("text/html"),
                "python_ms": round(elapsed * 1000, 2) if self.timed else 0}
        if pad is not None:
            case["request"] = {"head": self._blob("reqh", head)["file"], "fill": pad[0], "count": pad[1],
                               "tail": self._blob("reqt", tail)["file"]}
        else:
            case["request"] = self._blob("req", body)
        case["response"] = self._blob("res", data)
        self.cases.append(case)
        return case["status"], headers, data

    def function(self, case: dict, output: str):
        case["response"] = self._blob("res", output.encode())
        self.cases.append(case)

    def save(self):
        lines = ",\n".join(json.dumps(c, separators=(",", ":"), ensure_ascii=False) for c in self.cases)
        (self.out / "cases.json").write_text(f"[\n{lines}\n]\n", encoding="utf-8")


# --- synthetic models ----------------------------------------------------------------


def vox(x, y, z, rgb=(200, 60, 40), t=21, w=0):
    return {"x": x, "y": y, "z": z, "r": rgb[0], "g": rgb[1], "b": rgb[2], "w": w, "type": t}


def models():
    from utils.kiwi_blueprint import codec
    out = {}
    sword = [vox(1, y, 0, (90, 60, 30)) for y in range(3)]
    sword += [vox(x, y, 0, (180, 190, 200), 21, 1 if x == 1 else 4) for y in range(3, 12) for x in range(3)]
    sword += [vox(1, 12, 0, (255, 40, 40), 55, 0), vox(0, 2, 0, (40, 200, 255), 18, 3),
              vox(2, 2, 0, (40, 200, 255), 56, 6), vox(1, 1, 1, (5, 5, 5), 21, 7),
              vox(0, 0, 1, (0, 0, 0), 39, 0), vox(2, 0, 1, (10, 10, 10), 1, 0), vox(2, 13, 1, (9, 9, 9), 54, 2)]
    ents = codec.write_entity_records([(0, 0, 1, b"\x0a\x16placeable/deco/chair_01\x1e"),
                                       (2, 3, 0, b"\x0a\x0fprefabs/lamp_02\x1e\x0a\x0bitem/x/y_z")], b"")
    out["sword"] = codec.encode(sword, version=5, pos=(-1, -1, 0), size=(3, 14, 2), entity_blob=ents)

    hat = [vox(x, y, z, (30 + 20 * x, 120, 60 + 10 * z), 21 if y < 2 else 18, y)
           for x in range(4) for y in range(3) for z in range(3) if (x + y + z) % 3 != 1]
    out["hat"] = codec.encode(hat, version=5, pos=(-2, 7, -1))

    def v34(version, voxels, tail):
        b = bytearray(b"kiwib" + struct.pack("<I", version) + codec.write_uleb128(len(voxels)))
        for x, y, z, t, rgb, w in voxels:
            b += codec.write_svarint(x) + codec.write_svarint(y) + codec.write_svarint(z)
            b += struct.pack("<HBBBB", t, rgb[2], rgb[1], rgb[0], w)
        return bytes(b + tail)

    deco = [(-2, 0, 3, 21, (100, 80, 60), 0), (-1, 0, 3, 21, (100, 80, 60), 1), (-1, 1, 3, 39, (0, 0, 0), 0),
            (0, 0, 4, 18, (50, 90, 200), 5), (-1, 0, 3, 21, (1, 2, 3), 0), (3, 2, 1, 24, (4, 4, 4), 0)]
    out["deco_v4"] = v34(4, deco, codec.write_entity_records([(-1, 1, 3, b"\x0a\x10placeable/x/stool")], b"\x99"))
    out["old_v3"] = v34(3, [(0, 0, 0, 21, (250, 250, 250), 0), (1, 0, 0, 55, (250, 20, 20), 0),
                            (0, 1, 0, 21, (0, 0, 1), 0)], b"")
    # v5 whose entity section claims three records but holds one: can't be moved.
    out["broken_entities"] = codec.encode([vox(0, 0, 0), vox(1, 0, 0)], version=5, pos=(0, 0, 0),
                                          entity_blob=b"\x03\x00\x00\x00\x02\x02\x02\x01A")
    # v5 with a zero delta: two voxels on one cell.
    body = struct.pack("<8i", 0, 0, 0, 2, 1, 1, 3, 0) + struct.pack("<2i", 0, 1) + struct.pack("<3H", 21, 18, 21)
    body += struct.pack("<3I", 0x00FF0000, 0x0300FF00, 0x000000FF) + b"\0\0\0\0"
    out["dup_cells"] = b"kiwib" + struct.pack("<I", 5) + zlib.compress(body, 9)
    out["empty_v5"] = codec.encode([vox(0, 0, 0)], version=5)[:9] + zlib.compress(struct.pack("<8i", 0, 0, 0, 1, 1, 1, 0, 0))
    out["zero_bounds"] = b"kiwib" + struct.pack("<I", 5) + zlib.compress(struct.pack("<8i", 0, 0, 0, 0, 1, 1, 1, 0) + b"\0" * 10)
    out["short_payload"] = b"kiwib" + struct.pack("<I", 5) + zlib.compress(struct.pack("<7i", 0, 0, 0, 1, 1, 1, 1) + b"\0\0")
    out["truncated_v5"] = b"kiwib" + struct.pack("<I", 5) + zlib.compress(struct.pack("<8i", 0, 0, 0, 4, 4, 4, 9, 0) + b"\0" * 12)
    out["truncated_v3"] = out["old_v3"][:-4]
    out["bad_zlib"] = b"kiwib" + struct.pack("<I", 5) + b"\x78\x9c\xff\xff\xff"
    out["v6"] = b"kiwib" + struct.pack("<I", 6) + b"\0" * 8
    out["not_kiwib"] = b"hello world, this isn't a blueprint"
    return out


def flat_qb(name, size, pos, cells):
    """A hand-built uncompressed .qb."""
    sx, sy, sz = size
    out = bytearray(struct.pack("<6I", 257, 0, 1, 0, 0, 1))
    out += bytes([len(name)]) + name.encode() + struct.pack("<3I", *size) + struct.pack("<3i", *pos)
    for z in range(sz):
        for y in range(sy):
            for x in range(sx):
                rgb = cells.get((x, y, z))
                out += bytes([*rgb, 255]) if rgb else b"\0\0\0\0"
    return bytes(out)


def rle_qb(mats, bgra, left):
    """A hand-built RLE .qb: `mats` is `[(name, size, pos, cells)]`."""
    out = bytearray(struct.pack("<6I", 257, 1 if bgra else 0, 0 if left else 1, 1, 0, len(mats)))
    for name, (sx, sy, sz), p, cells in mats:
        out += bytes([len(name)]) + name.encode() + struct.pack("<3I", sx, sy, sz) + struct.pack("<3i", *p)
        for z in range(sz):
            zz = sz - 1 - z if left else z
            run = []
            for y in range(sy):
                for x in range(sx):
                    rgb = cells.get((x, y, zz))
                    run.append((rgb[2], rgb[1], rgb[0]) if (rgb and bgra) else rgb)
            i = 0
            while i < len(run):
                j = i
                while j < len(run) and run[j] == run[i]:
                    j += 1
                px = bytes([*run[i], 255]) if run[i] else b"\0\0\0\0"
                if j - i > 1:
                    out += struct.pack("<II", 2, j - i) + px
                else:
                    out += px
                i = j
            out += struct.pack("<I", 6)
    return bytes(out)


# --- the cases ---------------------------------------------------------------------


def single_blueprint_cases(rec: Recorder, m: dict):
    from utils.kiwi_blueprint import editor
    j = json.dumps
    up = lambda name, data: ("file", (name, data))  # noqa: E731

    for key in ("sword", "hat", "deco_v4", "old_v3", "dup_cells", "broken_entities", "empty_v5", "zero_bounds",
                "short_payload", "truncated_v5", "truncated_v3", "bad_zlib", "v6", "not_kiwib"):
        rec.call(f"inspect {key}", path="/api/blueprint-editor/inspect", fields=[up(f"{key}.blueprint", m[key])])
    rec.call("inspect odd name", path="/api/blueprint-editor/inspect", fields=[up("C:\\mods\\épée (v2).blueprint", m["sword"])])
    rec.call("inspect no file", path="/api/blueprint-editor/inspect", fields=[("edits", "[]")])
    rec.call("inspect empty file", path="/api/blueprint-editor/inspect", fields=[up("a.blueprint", b"")])
    rec.call("inspect empty filename", path="/api/blueprint-editor/inspect", fields=[up("", m["sword"])])
    rec.call("inspect too large", path="/api/blueprint-editor/inspect",
             fields=[up("big.blueprint", b"kiwib\x05\x00\x00\x00<PAD>")], pad=(0x41, 4 * 1024 * 1024))
    rec.call("inspect urlencoded", path="/api/blueprint-editor/inspect", body=b"file=abc", content_type="application/x-www-form-urlencoded")
    rec.call("inspect no boundary", path="/api/blueprint-editor/inspect", body=b"--x\r\n", content_type="multipart/form-data")
    rec.call("inspect unterminated", path="/api/blueprint-editor/inspect",
             body=f"--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\nabc".encode(),
             content_type=f"multipart/form-data; boundary={BOUNDARY}")

    sword_payload = editor.inspect(m["sword"])
    placeholder = sword_payload["type"].index(39)
    terrain = sword_payload["type"].index(1)
    good = [{"i": 0, "rgb": 0x123456}, {"i": 1, "type": 18, "w": 9}, {"i": 2, "del": True},
            {"add": [-1, 0, 0], "rgb": 0xFF00FF, "type": 21, "w": 2}, {"add": [1, 1, 0], "rgb": 0x00FF00, "type": "55", "w": 3},
            {"i": placeholder, "type": 21, "w": 0}, {"i": terrain, "rgb": 0xFFFFFF}, {"i": 4, "rgb": 5, "type": 56, "w": -3},
            {"i": 4, "rgb": 0xABCDEF}, {"i": "5", "w": 1, "type": 54}, {"i": 6.9, "rgb": True}]
    edit_sets = {
        "none": "[]", "good": j(good), "recolour only": j([{"i": 3, "rgb": 0x445566}]),
        "not json": "{oops", "dict": "{}", "number list": "[1]", "out of range": j([{"i": 999, "rgb": 1}]),
        "no index": j([{"x": 1}]), "bad colour": j([{"i": 0, "rgb": -1}]), "colour string": j([{"i": 0, "rgb": "0x10"}]),
        "half material": j([{"i": 0, "type": 21}]), "non palette": j([{"i": 0, "type": 1, "w": 0}]),
        "two coords": j([{"add": [0, 0], "type": 21, "w": 0, "rgb": 1}]),
        "far add": j([{"add": [0, 0, 5000], "type": 21, "w": 0, "rgb": 1}]),
        "bad coord": j([{"add": [0, 0, "x"], "type": 21, "w": 0, "rgb": 1}]),
        "add without rgb": j([{"add": [0, 0, 0], "type": 21, "w": 0}]),
        "nan index": '[{"i": NaN, "rgb": 1}]', "infinite index": '[{"i": Infinity, "rgb": 1}]',
        "null add": j([{"add": None}]), "erase all": j([{"i": i, "del": 1} for i in range(sword_payload["count"])]),
        "bool type": j([{"i": 0, "type": True, "w": 0}]),
        "huge negative add": j([{"add": [-1e300, 0, 0], "rgb": 1, "type": 21, "w": 0}]),
        "huge w": j([{"i": 0, "type": 21, "w": 1e300}]), "infinite rgb": '[{"i": 0, "rgb": Infinity}]',
        "huge index": j([{"i": 10 ** 30, "rgb": 1}]),
    }
    for label, edits in edit_sets.items():
        rec.call(f"save sword edits {label}", path="/api/blueprint-editor/save",
                 fields=[up("My Sword.blueprint", m["sword"]), ("edits", edits)])
    for key in ("hat", "deco_v4", "old_v3", "dup_cells"):
        rec.call(f"save {key} untouched", path="/api/blueprint-editor/save", fields=[up(f"{key}", m[key])])
        rec.call(f"save {key} grown", path="/api/blueprint-editor/save",
                 fields=[up(f"{key}.BLUEPRINT", m[key]),
                         ("edits", j([{"add": [-2, 1, -1], "rgb": 0x102030, "type": 18, "w": 4}, {"i": 0, "del": True}]))])
    rec.call("save broken entities grown", path="/api/blueprint-editor/save",
             fields=[up("b.blueprint", m["broken_entities"]), ("edits", j([{"add": [-1, 0, 0], "rgb": 1, "type": 21, "w": 0}]))])

    op_sets = {"rotate_x": ["rotate_x"], "rotate_y": ["rotate_y"], "rotate_z": ["rotate_z"], "mirror_x": ["mirror_x"],
               "mirror_y": ["mirror_y"], "mirror_z": ["mirror_z"], "twice": ["rotate_y", "rotate_y"],
               "mixed": ["mirror_x", "rotate_x", "mirror_z", "rotate_z"], "empty": [], "unknown": ["spin"],
               "number": [5], "dict": [{"a": 1}], "too many": ["mirror_x"] * 17}
    for key in ("sword", "hat", "deco_v4", "old_v3"):
        for label, ops in op_sets.items():
            if key != "sword" and label in ("empty", "unknown", "number", "dict", "too many"):
                continue
            rec.call(f"transform {key} {label}", path="/api/blueprint-editor/transform",
                     fields=[up("m.blueprint", m[key]), ("edits", j(good[:3]) if key == "sword" else "[]"), ("ops", j(ops))])
    rec.call("transform string ops", path="/api/blueprint-editor/transform", fields=[up("m.blueprint", m["sword"]), ("ops", '"rotate_x"')])
    rec.call("transform bad json", path="/api/blueprint-editor/transform", fields=[up("m.blueprint", m["sword"]), ("ops", "[")])
    rec.call("transform broken entities", path="/api/blueprint-editor/transform",
             fields=[up("m.blueprint", m["broken_entities"]), ("ops", '["rotate_y"]')])

    kinds = ["melee", "gun", "staff", "bow", "fist", "spear", "mask", "hat", "hair", "deco", "other", "bogus"]
    for key in ("sword", "hat", "deco_v4", "old_v3"):
        for kind in kinds:
            rec.call(f"check {key} {kind}", path="/api/blueprint-editor/check",
                     fields=[up("m.blueprint", m[key]), ("kind", kind), ("edits", "[]")])
    rec.call("check sword edited", path="/api/blueprint-editor/check", fields=[up("m.blueprint", m["sword"]), ("edits", j(good))])

    for key, name in (("sword", "My Sword (v2).blueprint"), ("hat", "épée.BLUEPRINT"), ("deco_v4", "noext"), ("old_v3", "#.blueprint")):
        rec.call(f"export-qb {key}", path="/api/blueprint-editor/export-qb", fields=[up(name, m[key]), ("edits", "[]")])
    rec.call("export-qb sword edited", path="/api/blueprint-editor/export-qb", fields=[up("s.blueprint", m["sword"]), ("edits", j(good))])

    layer = lambda d: ("layers", ("layer.blueprint", d))  # noqa: E731
    stacks = {
        "attachment": ([m["hat"]], [{"mode": "attachment"}], "0"),
        "centre offset": ([m["hat"]], [{"mode": "centre", "offset": [1, -2, 3]}], "0"),
        "corner anchor 1": ([m["hat"]], [{"mode": "corner"}], "1"),
        "two layers": ([m["hat"], m["deco_v4"]], [{"mode": "centre"}, {"mode": "corner", "offset": [0, 5, 0], "edits": [{"i": 0, "rgb": 7}]}], "2"),
        "bogus mode": ([m["hat"]], [{"mode": "bogus"}], "0"),
        "v3 attachment": ([m["old_v3"]], [{}], "0"),
        "spec mismatch": ([m["hat"], m["hat"]], [{}], "0"),
        "spec not list": ([m["hat"]], {"mode": "corner"}, "0"),
        "bad offset": ([m["hat"]], [{"mode": "corner", "offset": ["a"]}], "0"),
        "far offset": ([m["hat"]], [{"mode": "corner", "offset": [5000, 0, 0]}], "0"),
        "string offset": ([m["hat"]], [{"mode": "corner", "offset": "123"}], "0"),
        "number offset": ([m["hat"]], [{"mode": "corner", "offset": 5}], "0"),
        "huge offset": ([m["hat"]], [{"mode": "corner", "offset": [-1e300, 0, 0]}], "0"),
        "nine layers": ([m["hat"]] * 9, [{"mode": "corner"}] * 9, "0"),
        "anchor out": ([m["hat"]], [{"mode": "corner"}], "5"),
        "anchor junk": ([m["hat"]], [{"mode": "corner"}], "x"),
        "layer bad edits": ([m["hat"]], [{"mode": "corner", "edits": "nope"}], "0"),
        "empty layer": ([m["empty_v5"]], [{"mode": "corner"}], "0"),
        "entity layers": ([m["deco_v4"], m["broken_entities"]], [{"mode": "corner"}, {"mode": "corner"}], "0"),
    }
    for label, (layers, specs, anchor) in stacks.items():
        fields = [up("base.blueprint", m["sword"]), ("edits", j(good[:4]))]
        fields += [layer(d) for d in layers] + [("stack", j(specs)), ("anchor_at", anchor)]
        rec.call(f"flatten {label}", path="/api/blueprint-editor/flatten", fields=fields)
        if label in ("attachment", "two layers", "centre offset"):
            rec.call(f"save stack {label}", path="/api/blueprint-editor/save", fields=fields)
            rec.call(f"check stack {label}", path="/api/blueprint-editor/check", fields=fields + [("kind", "melee")])
            rec.call(f"export-qb stack {label}", path="/api/blueprint-editor/export-qb", fields=fields)
    rec.call("flatten no layers", path="/api/blueprint-editor/flatten", fields=[up("b.blueprint", m["sword"])])
    rec.call("flatten deco base", path="/api/blueprint-editor/flatten",
             fields=[up("b.blueprint", m["deco_v4"]), layer(m["old_v3"]), ("stack", j([{"mode": "centre"}]))])


def qb_cases(rec: Recorder, m: dict):
    from utils.kiwi_blueprint import editor
    up = lambda name, data: ("files", (name, data))  # noqa: E731
    exported = {}
    for key in ("sword", "hat", "deco_v4"):
        archive, _ = editor.export_qb(m[key], [], stem=key)
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            exported[key] = {n: zf.read(n) for n in zf.namelist()}
    s, h = exported["sword"], exported["hat"]
    sets = {
        "sword all maps": [(n, d) for n, d in s.items()],
        "sword reversed": list(reversed(list(s.items()))),
        "sword base only": [("sword.qb", s["sword.qb"])],
        "sword base and t": [("sword.QB", s["sword.qb"]), ("x/sword_T.qb", s["sword_t.qb"])],
        "hat all maps": list(h.items()),
        "deco all maps": list(exported["deco_v4"].items()),
        "mismatched map": [("sword.qb", s["sword.qb"]), ("hat_a.qb", h["hat_a.qb"])],
        "no base": [("sword_a.qb", s["sword_a.qb"])],
        "two bases": [("a.qb", h["hat.qb"]), ("b.qb", s["sword.qb"])],
        "duplicate names": [("a.qb", s["sword.qb"]), ("a.qb", h["hat.qb"])],
        "not qb": [("sword.txt", s["sword.qb"])],
        "five files": [(f"m{i}.qb", s["sword.qb"]) for i in range(5)],
        "too short": [("m.qb", b"\x01\x02")],
        "zero matrices": [("m.qb", struct.pack("<6I", 257, 0, 1, 1, 0, 0))],
        "truncated": [("m.qb", s["sword.qb"][:40])],
    }
    cells = {(0, 0, 0): (200, 10, 10), (1, 0, 0): (200, 10, 10), (1, 1, 0): (10, 200, 10), (2, 2, 1): (10, 10, 200)}
    sets["offset attach"] = [("m.qb", rle_qb([("m", (3, 3, 2), (-1, 0, 0), cells)], False, False))]
    sets["bgra left-handed"] = [("m.qb", rle_qb([("m", (3, 3, 2), (0, 0, 0), cells)], True, True))]
    sets["uncompressed"] = [("m.qb", flat_qb("m", (3, 3, 2), (0, 0, 0), cells))]
    sets["two matrices"] = [("m.qb", rle_qb([("a", (3, 3, 2), (0, 0, 0), cells), ("b", (2, 2, 2), (4, -1, 0), {(0, 0, 0): (1, 2, 3)})], False, False))]
    sets["only marker"] = [("m.qb", rle_qb([("m", (2, 2, 2), (0, 0, 0), {(1, 1, 1): (255, 0, 255)})], False, False))]
    sets["empty"] = [("m.qb", rle_qb([("m", (2, 2, 2), (0, 0, 0), {})], False, False))]
    sets["unknown map colours"] = [("m.qb", rle_qb([("m", (3, 3, 2), (0, 0, 0), cells)], False, False)),
                                    ("m_t.qb", rle_qb([("m", (3, 3, 2), (0, 0, 0), {k: (1, 2, 3) for k in cells})], False, False)),
                                    ("m_s.qb", rle_qb([("m", (3, 3, 2), (0, 0, 0), {k: (9, 9, 9) for k in cells})], False, False))]
    for label, files in sets.items():
        rec.call(f"import-qb {label}", path="/api/blueprint-editor/import-qb", fields=[up(n, d) for n, d in files])
    rec.call("import-qb nothing", path="/api/blueprint-editor/import-qb", fields=[("x", "1")])


def model_cases(rec: Recorder, m: dict):
    from utils.kiwi_blueprint import tmod, workshop
    j = json.dumps
    files = [("blueprints/sword.blueprint", m["sword"]), ("blueprints/Hat.blueprint", m["hat"]),
             ("blueprints/empty.blueprint", m["empty_v5"]), ("config.cfg", b"[a]\nb=1\n"), ("preview.png", b"\x89PNG..")]
    zipped = workshop.to_zip(files)
    props = {"title": "Kit Café", "author": "me", "tags": "Mounts, wings,Bogus", "modLoader": "BTT"}
    tmodded = tmod.build_tmod(1, props, files, mod_loader="BTT")
    edits = {"blueprints/sword.blueprint": [{"i": 0, "rgb": 0x112233}, {"add": [-1, -1, 0], "rgb": 1, "type": 21, "w": 0}]}
    moves = {"blueprints/Hat.blueprint": [0, 2, -1], "blueprints/sword.blueprint": [0, 0, 0]}
    ok = lambda archive, name: [("file", (name, archive))]  # noqa: E731

    rec.call("model-save zip", path="/api/blueprint-editor/model-save",
             fields=ok(zipped, "kit.zip") + [("edits", j(edits)), ("moves", j(moves)), ("paths", "[]"), ("name", "kit.zip")])
    rec.call("model-save tmod with parts", path="/api/blueprint-editor/model-save",
             fields=ok(tmodded, "Kit.tmod") + [("files", ("a.blueprint", m["old_v3"])), ("files", ("b.blueprint", m["deco_v4"])),
                                              ("files", ("c.blueprint", m["hat"])),
                                              ("paths", j(["blueprints/new.blueprint", "", "../Horn"])),
                                              ("edits", j(edits)), ("moves", "{}"), ("name", "C:\\x\\Kit Café.TMOD")])
    rec.call("model-save replace part", path="/api/blueprint-editor/model-save",
             fields=ok(zipped, "kit.zip") + [("files", ("x.blueprint", m["deco_v4"])), ("paths", j(["blueprints/sword.blueprint"]))])
    rec.call("model-save loose", path="/api/blueprint-editor/model-save",
             fields=[("files", ("sword.blueprint", m["sword"])), ("files", ("hat.blueprint", m["hat"])),
                     ("edits", j({"hat.blueprint": [{"i": 1, "del": True}]})), ("moves", j({"sword.blueprint": ["1", 0, 0]})), ("name", "My Model.ZIP")])
    errors = {
        "edits not dict": [("edits", "[]")], "moves not dict": [("moves", "[]")], "paths not list": [("paths", "{}")],
        "unknown path": [("edits", j({"nope.blueprint": [{"i": 0, "rgb": 1}]}))],
        "paths mismatch": [("paths", j(["a.blueprint"]))], "move number": [("moves", j({"blueprints/Hat.blueprint": 5}))],
        "move far": [("moves", j({"blueprints/Hat.blueprint": [600, 0, 0]}))],
        "move bad": [("moves", j({"blueprints/Hat.blueprint": ["a", 0, 0]}))],
        "move short": [("moves", j({"blueprints/Hat.blueprint": [1, 0]}))],
        "move falsy": [("moves", j({"blueprints/Hat.blueprint": 0}))],
        "move huge": [("moves", j({"blueprints/Hat.blueprint": [-1e300, 0, 0]}))],
        "move four": [("moves", j({"blueprints/Hat.blueprint": [1, 0, 0, 0]}))],
        "move string": [("moves", j({"blueprints/Hat.blueprint": "101"}))],
        "bad edits json": [("edits", "{")],
        "edit error": [("edits", j({"blueprints/sword.blueprint": [{"i": 999, "rgb": 1}]}))],
        "edit empty part": [("edits", j({"blueprints/empty.blueprint": [{"i": 0, "rgb": 1}]}))],
    }
    for label, extra in errors.items():
        rec.call(f"model-save {label}", path="/api/blueprint-editor/model-save", fields=ok(zipped, "kit.zip") + extra)
    rec.call("model-save nothing", path="/api/blueprint-editor/model-save", fields=[("edits", "{}")])

    bad_zip = zipped[:-30]
    junk_zip = workshop.to_zip([("__MACOSX/a", b"1"), ("x/Thumbs.db", b"2"), ("dir/", b"")])
    no_bp_zip = workshop.to_zip([("readme.txt", b"hi")])
    for label, fields in {
        "no files": [("edits", "{}")], "loose not blueprint": [("files", ("a.txt", b"x"))],
        "empty file": [("file", ("a.zip", b""))], "zip without blueprints": [("file", ("a.zip", no_bp_zip))],
        "bad zip": [("file", ("a.zip", bad_zip))], "junk zip": [("file", ("a.zip", junk_zip))],
        "garbage tmod": [("file", ("a.tmod", b"\x30\x00\x00\x00\x00\x00\x00\x00garbage"))],
        "short tmod": [("file", ("a.tmod", b"\x01\x02"))],
        "pathless tmod": [("file", ("a.tmod", tmod.build_tmod(1, {}, [("./", b"x")])))],
    }.items():
        rec.call(f"model {label}", path="/api/blueprint-editor/model", fields=fields)
    rec.call("game-model no prefab", method="GET", path="/api/blueprint-editor/game-model", query="prefab=+")
    for path in ("/api/rigs/adventurer/graph", "/api/rigs/adventurer/anim/mount_balance_idle", "/api/rigs/nope/graph",
                 "/api/rigs/Adventurer/graph", "/api/rigs/adventurer/anim/nope", "/api/rigs/a-b/anim/c"):
        rec.call(f"GET {path}", method="GET", path=path)


def open_project_cases(rec: Recorder, m: dict):
    from utils.kiwi_blueprint import model as bp_model
    files = [("blueprints/Sword.blueprint", m["sword"]), ("blueprints/hat.blueprint", m["hat"]),
             ("blueprints/empty.blueprint", m["empty_v5"]), ("blueprints/boots.blueprint", m["deco_v4"]),
             ("blueprints/bad.blueprint", m["zero_bounds"]), ("readme.txt", b"hi")]
    stored = []
    for i, (p, d) in enumerate(files):
        name = f"part_{i}.bin"
        (rec.out / name).write_bytes(d)
        stored.append([p, name])
    variants = [
        ("adventurer", {"sword": "r_hand", "hat": "hat", "boots": "nope"}, 1.25, {"sword": 0.5}),
        ("adventurer", {"sword": "r_hand", "hat": "head", "boots": "foot_l"}, 2.0, None),
        (None, {"sword": "r_hand", "hat": "hat"}, 1.0, {"hat": 3.0}),
        ("not_a_rig", {"sword": "r_hand"}, 1.0, {}),
    ]
    for rig, attach, head, scales in variants:
        payload = bp_model.open_project(files, rig_name=rig, attach=attach, name="kit.zip", head_scale=head, part_scales=scales)
        payload["source"] = "zip"
        rec.function({"name": f"open_project {rig} {head}", "function": "open_project", "files": stored, "rig": rig,
                      "attach": list(attach.items()), "head_scale": head, "part_scales": list((scales or {}).items()),
                      "has_part_scales": scales is not None, "project_name": "kit.zip"}, json.dumps(payload))


def fixtures():
    out = ROOT / "core" / "tests" / "fixtures" / "blueprint"
    for f in out.glob("*"):
        f.unlink()
    with tempfile.TemporaryDirectory() as appdata:
        app = setup(Path(appdata))
        rec = Recorder(app, out, big=16 * 1024)
        m = models()
        single_blueprint_cases(rec, m)
        qb_cases(rec, m)
        model_cases(rec, m)
        open_project_cases(rec, m)
        rec.save()
    total = sum(f.stat().st_size for f in out.glob("*"))
    print(f"{len(rec.cases)} cases, {total / 1024:.0f} KiB in {out}")


# --- the real install --------------------------------------------------------------


def install(out_dir: Path):
    with tempfile.TemporaryDirectory() as appdata:
        app = setup(Path(appdata))
        from utils.kiwi_blueprint import game_data, tmod, workshop
        rec = Recorder(app, out_dir, big=64 * 1024, timed=True)
        game = Path(r"C:\Program Files (x86)\Glyph\Games\Trove\Live")
        j = json.dumps

        t = time.perf_counter()
        rig = None
        while rig is None:
            rig = game_data.rig_map(game)
            time.sleep(0.25)
        index_s = time.perf_counter() - t
        cache = Path(appdata) / "Trove" / "ModManagerCache" / "blueprint_editor" / "rig_index.json"
        (out_dir / "rig_index.json").write_bytes(cache.read_bytes())

        paths = game_data.blueprint_paths(game)
        allp = sorted(p for v in paths.values() for p in v)
        random.seed(11)
        picks = random.sample(allp, 40)
        raws = {p: game_data.read_game_file(game, p) for p in picks}
        sizes = []
        for p in random.sample(allp, 3000):
            raw = game_data.read_game_file(game, p)
            sizes.append((len(raw or b""), p))
        sizes.sort(reverse=True)
        for _, p in sizes[:3]:
            raws[p] = game_data.read_game_file(game, p)
        for p, raw in raws.items():
            if not raw:
                continue
            up = [("file", (p.rsplit("/", 1)[-1], raw))]
            status, _, body = rec.call(f"inspect {p}", path="/api/blueprint-editor/inspect", fields=up)
            if status != 200:
                continue
            payload = json.loads(body)
            n = payload["count"]
            edits = [{"i": i, "rgb": (i * 7919) & 0xFFFFFF} for i in range(0, n, max(1, n // 10))]
            edits += [{"i": i, "type": 18, "w": i % 8} for i in range(1, n, max(1, n // 7))]
            edits += [{"i": i, "del": True} for i in range(2, n, max(1, n // 5))][:5]
            edits += [{"add": [-1, 0, 0], "rgb": 0x336699, "type": 21, "w": 1}, {"add": [payload["size"][0], 0, 0], "rgb": 1, "type": 55, "w": 0}]
            rec.call(f"save {p}", path="/api/blueprint-editor/save", fields=up)
            rec.call(f"save edited {p}", path="/api/blueprint-editor/save", fields=up + [("edits", j(edits))])
            rec.call(f"transform {p}", path="/api/blueprint-editor/transform", fields=up + [("ops", '["rotate_y", "mirror_x"]')])
            rec.call(f"check {p}", path="/api/blueprint-editor/check", fields=up + [("kind", "melee")])
            rec.call(f"export-qb {p}", path="/api/blueprint-editor/export-qb", fields=up + [("edits", j(edits))])

        creatures = sorted(rig.creatures)
        random.seed(5)
        chosen = random.sample(creatures, 8) + [c for c in creatures if "dragon" in c][:2]
        for prefab in chosen:
            rec.call(f"game-model {prefab}", method="GET", path="/api/blueprint-editor/game-model", query="prefab=" + prefab)
        stems = {}
        for c in creatures:
            stems.setdefault(game_data.prefab_stem(c).lower(), []).append(c)
        unique = next(s for s, v in sorted(stems.items()) if len(v) == 1)
        ambiguous = next((s for s, v in sorted(stems.items()) if len(v) > 1), None)
        for q in [unique, unique.upper() + ".binfab", f"/{chosen[0]}", ambiguous, "nope_nothing"]:
            if q:
                rec.call(f"game-model {q}", method="GET", path="/api/blueprint-editor/game-model", query="prefab=" + q)
        for q in ["", "q=dragon", "q=drag+mount&type=mount", "type=ally&limit=5", "limit=abc", "limit=0", "limit=500&q=a",
                  "q=zzzz", "q=%C3%A9", "type=wings&q=wing", "q=Dragon%20Mount&limit=3"]:
            rec.call(f"search {q}", method="GET", path="/api/blueprint-editor/search", query=q)
        rec.call("brdf", method="GET", path="/api/render/brdf-map.png")

        from models.trove.prefab_ally import _load_index
        bp_index = _load_index(game / "blueprints")[1]
        names_by_base = game_data.blueprint_paths(game)

        def weight(prefab):
            total = 0
            for b in rig.creatures[prefab][1]:
                pth = game_data.nearest_path(names_by_base.get(f"{b}.blueprint", []), prefab)
                found = bp_index.get(pth.split("/", 1)[1]) if pth else None
                total += found[1]["size"] if found else 0
            return total
        biggest = sorted(creatures, key=lambda c: (-weight(c), c))[:3]
        for prefab in chosen[:4] + biggest:
            skeleton, parts = rig.creatures[prefab]
            bp_paths = game_data.blueprint_paths(game)
            files = []
            for b in parts:
                pth = game_data.nearest_path(bp_paths.get(f"{b}.blueprint", []), prefab)
                raw = game_data.read_game_file(game, pth) if pth else None
                if raw:
                    files.append((f"blueprints/{b}.blueprint", raw))
            if not files:
                continue
            zipped = workshop.to_zip(files + [("x.cfg", b"a=1")])
            tm = tmod.build_tmod(1, {"title": "T"}, files)
            stem = game_data.prefab_stem(prefab)
            rec.call(f"model zip {prefab}", path="/api/blueprint-editor/model", fields=[("file", (f"{stem}.zip", zipped))])
            rec.call(f"model tmod {prefab}", path="/api/blueprint-editor/model", fields=[("file", (f"{stem}.tmod", tm))])
            rec.call(f"model loose {prefab}", path="/api/blueprint-editor/model",
                     fields=[("files", (p.rsplit("/", 1)[-1], d)) for p, d in files])
            first = files[0][0]
            rec.call(f"model-save {prefab}", path="/api/blueprint-editor/model-save",
                     fields=[("file", (f"{stem}.tmod", tm)), ("edits", j({first: [{"i": 0, "rgb": 0xFF0000}]})),
                             ("moves", j({first: [0, 1, 0]})), ("name", f"{stem}.tmod")])
        rec.save()
        print(f"{len(rec.cases)} cases in {out_dir}; python rig index {index_s:.1f}s")
        meta = {"python_index_seconds": round(index_s, 2)}
        (out_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def sweep(out_file: Path, count: int):
    """Engine-level hashes for `count` real blueprints: the Rust side reads the same files."""
    with tempfile.TemporaryDirectory() as appdata:
        setup(Path(appdata))
        from models.trove.prefab_ally import _load_index, read_archive_content
        from utils.kiwi_blueprint import editor, qb
        game = Path(r"C:\Program Files (x86)\Glyph\Games\Trove\Live")
        entries, by_path = _load_index(game / "blueprints")
        names = sorted(full for _, full, _ in entries if full.lower().endswith(".blueprint"))
        random.seed(23)
        picks = random.sample(names, min(count, len(names)))
        sha = lambda b: hashlib.sha256(b if isinstance(b, bytes) else json.dumps(b).encode()).hexdigest()[:24]  # noqa: E731

        def guard(fn):
            try:
                return fn()
            except editor.EditorError as exc:
                return f"editor: {exc}"
            except Exception:  # noqa: BLE001 - anything else is a 500 in the route
                return "internal"

        rows = []
        t = time.perf_counter()
        for full in picks:
            tfi, entry = by_path[full]
            arc = read_archive_content(tfi.parent / f"archive{entry['archive_index']}.tfa")
            raw = arc[entry["offset"]:entry["offset"] + entry["size"]]
            row = {"path": "blueprints/" + full, "inspect": guard(lambda: sha(editor.inspect(raw, name="m.blueprint")))}
            if not row["inspect"].startswith(("editor", "internal")):
                n = editor.inspect(raw)["count"]
                edits = [{"i": i, "rgb": (i * 7919) & 0xFFFFFF} for i in range(0, n, max(1, n // 10))]
                edits += [{"i": i, "type": 54, "w": i % 9} for i in range(1, n, max(1, n // 7))]
                edits += [{"i": i, "del": True} for i in range(2, n, max(1, n // 5))][:5]
                edits += [{"add": [-2, 1, 0], "rgb": 0x336699, "type": 21, "w": 1}]
                row["edits"] = json.dumps(edits)
                row["save"] = guard(lambda: sha(editor.composite(raw, [])[0]))
                both = lambda pair: sha(pair[0] + json.dumps(pair[1]).encode())  # noqa: E731
                row["edited"] = guard(lambda: both(editor.composite(raw, edits)))
                row["transform"] = guard(lambda: both(editor.transform(raw, [], ["rotate_y", "mirror_x", "rotate_z"])))
                row["check"] = guard(lambda: sha(editor.check(raw, [], "hat")))

                def export():
                    archive, summary = editor.export_qb(raw, edits, stem="m")
                    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
                        files = {nm: zf.read(nm) for nm in zf.namelist()}
                    back = guard(lambda: both(qb.to_blueprint(files)))
                    return sha(archive + json.dumps(summary["notes"]).encode()) + "/" + back
                row["qb"] = guard(export)
            rows.append(row)
        elapsed = time.perf_counter() - t
        out_file.write_text(json.dumps({"python_seconds": round(elapsed, 2), "rows": rows}), encoding="utf-8")
        print(f"{len(rows)} blueprints in {elapsed:.1f}s -> {out_file}")


def mods(out_file: Path):
    """Every mod in the install's mods folder, unpacked and rebuilt (read-only)."""
    with tempfile.TemporaryDirectory() as appdata:
        setup(Path(appdata))
        from utils.kiwi_blueprint import editor, model as bp_model
        folder = Path(r"C:\Program Files (x86)\Glyph\Games\Trove\Live\mods")
        rows = []
        for f in sorted(folder.iterdir()):
            if not f.is_file():
                continue
            data = f.read_bytes()
            row = {"name": f.name}
            try:
                kind, props, files = bp_model.unpack(data, f.name)
                row.update(kind=kind, props=list(props.items()),
                           files=[[p, hashlib.sha256(d).hexdigest()[:24]] for p, d in files])
                out, ext = bp_model.repack(kind, props, files)
                row["repack"] = [ext, hashlib.sha256(out).hexdigest()[:24]]
            except editor.EditorError as exc:
                row["error"] = str(exc)
            rows.append(row)
        out_file.write_text(json.dumps(rows), encoding="utf-8")
        print(f"{len(rows)} mods -> {out_file}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["mods"] and len(sys.argv) == 3:
        mods(Path(sys.argv[2]))
        sys.exit()
    if sys.argv[1:2] == ["fixtures"]:
        fixtures()
    elif sys.argv[1:2] == ["install"] and len(sys.argv) == 3:
        install(Path(sys.argv[2]))
    elif sys.argv[1:2] == ["sweep"] and len(sys.argv) == 4:
        sweep(Path(sys.argv[2]), int(sys.argv[3]))
    else:
        sys.exit(__doc__)
