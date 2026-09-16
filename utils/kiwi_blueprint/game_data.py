"""The game data KiwiAPI's editor reads from its server, read from the local install instead.

KiwiAPI keeps a Postgres map of which prefab binds which blueprint parts to which bones, and
an archive of every game file. Here both come straight out of the install's ``.tfi``/``.tfa``
archives: the prefab tree is scanned once with ``binfab.extract_rig_refs`` and the result
cached on disk until the game's prefab indexes change.
"""
from __future__ import annotations

import json
import re
import struct
import threading
import zlib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from models.trove.prefab_ally import _load_index, load_language_map, read_archive_content
from utils.kiwi_blueprint import assembly, binfab
from utils.path import get_cache_root

INDEX_VERSION = 1


def _entries(game_path: Path, top: str):
    """``(tfi_path, "<top>/<path>", entry)`` for every file under one game folder."""
    root = game_path / top
    if not root.is_dir():
        return []
    entries, _ = _load_index(root)
    return [(tfi, f"{top}/{full}", entry) for tfi, full, entry in entries]


def _content(tfi_path: Path, entry: dict) -> bytes:
    archive = read_archive_content(tfi_path.parent / f"archive{entry['archive_index']}.tfa")
    return archive[entry["offset"]: entry["offset"] + entry["size"]]


def read_game_file(game_path: Path, path: str) -> bytes | None:
    top, _, rest = path.replace("\\", "/").partition("/")
    root = game_path / top
    if not rest or not root.is_dir():
        return None
    _, by_path = _load_index(root)
    found = by_path.get(rest) or by_path.get(rest.lower())
    return _content(*found) if found else None


def blueprint_paths(game_path: Path) -> dict[str, list[str]]:
    """``{filename.lower(): [every blueprint path with that name]}``."""
    out: dict[str, list[str]] = defaultdict(list)
    for _tfi, full, _entry in _entries(game_path, "blueprints"):
        if full.lower().endswith(".blueprint"):
            out[full.rsplit("/", 1)[-1].lower()].append(full)
    return out


def nearest_path(candidates: list[str], hint: str) -> str | None:
    """The candidate sharing the most folders with ``hint`` (the creature's prefab)."""
    if not candidates:
        return None
    if len(candidates) == 1 or not hint:
        return sorted(candidates)[0]
    want = {s for s in hint.replace("\\", "/").lower().split("/")[:-1] if s}

    def score(p: str) -> tuple:
        segs = [s for s in p.replace("\\", "/").lower().split("/")[:-1] if s]
        return (-len(want & set(segs)), p)
    return sorted(candidates, key=score)[0]


# --- the rig map ------------------------------------------------------------ #


@dataclass(frozen=True)
class RigMap:
    by_blueprint: dict[str, tuple[str, str]] = field(default_factory=dict)
    creatures: dict[str, tuple[str, dict[str, str]]] = field(default_factory=dict)
    owner: dict[str, str] = field(default_factory=dict)
    by_path: dict[str, str] = field(default_factory=dict)
    by_stem: dict[str, list[str]] = field(default_factory=dict)
    head_scale: dict[str, float] = field(default_factory=dict)
    mesh_scale: dict[tuple[str, str], float] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Scales:
    head: float = 1.0
    parts: dict[str, float] = field(default_factory=dict)


def prefab_stem(prefab: str) -> str:
    name = prefab.replace("\\", "/").rsplit("/", 1)[-1]
    return name[: -len(".binfab")] if name.lower().endswith(".binfab") else name


def _build_map(rows: list[list], names: dict[str, str]) -> RigMap:
    rig = RigMap(names=names)
    for prefab, blueprint, skeleton, ap, mesh_scale, head_scale in sorted(rows, key=lambda r: (r[0], r[1])):
        rig.by_blueprint.setdefault(blueprint, (skeleton, ap))
        rig.owner.setdefault(blueprint, prefab)
        if prefab not in rig.creatures:
            rig.creatures[prefab] = (skeleton, {})
            rig.by_path[prefab.lower()] = prefab
            rig.by_stem.setdefault(prefab_stem(prefab).lower(), []).append(prefab)
            rig.head_scale[prefab] = float(head_scale)
        rig.creatures[prefab][1][blueprint] = ap
        if float(mesh_scale) != 1.0:
            rig.mesh_scale[(prefab, blueprint)] = float(mesh_scale)
    return rig


def _signature(game_path: Path) -> list:
    sig = []
    for tfi in sorted((game_path / "prefabs").rglob("index.tfi")):
        st = tfi.stat()
        sig.append([str(tfi), st.st_mtime_ns, st.st_size])
    return [INDEX_VERSION, str(game_path), sig]


def _cache_file() -> Path:
    root = get_cache_root() / "blueprint_editor"
    root.mkdir(parents=True, exist_ok=True)
    return root / "rig_index.json"


def _scan(game_path: Path) -> tuple[list[list], dict[str, str]]:
    """Every creature binding in the install, plus each creature's display name."""
    by_archive: dict[Path, list] = defaultdict(list)
    for tfi, full, entry in _entries(game_path, "prefabs"):
        if full.lower().endswith(".binfab"):
            by_archive[tfi.parent / f"archive{entry['archive_index']}.tfa"].append((full, entry))
    language: dict[str, str] | None = None
    rows: list[list] = []
    names: dict[str, str] = {}
    for archive_path, files in by_archive.items():
        archive = read_archive_content(archive_path)
        for full, entry in files:
            data = archive[entry["offset"]: entry["offset"] + entry["size"]]
            if b".skeleton.gr2" not in data:
                continue
            rig = binfab.extract_rig_refs(data)
            if not rig:
                continue
            for bp, ap in rig["parts"].items():
                rows.append([full, bp, rig["skeleton"], ap, rig["scales"].get(bp, 1.0), rig["head_scale"]])
            ident = binfab.decode_identity(data) or {}
            key = ident.get("name_key") or ""
            if key.startswith("$"):
                if language is None:
                    language = load_language_map(game_path)
                name = language.get(key) or language.get(key.lstrip("$"))
                if name:
                    names[full] = name
    return rows, names


_lock = threading.Lock()
_state: dict = {"sig": None, "map": None, "building": False, "error": None}


def _load_or_build(game_path: Path) -> None:
    try:
        sig = _signature(game_path)
        cache = _cache_file()
        rows = names = None
        if cache.exists():
            try:
                saved = json.loads(cache.read_text(encoding="utf-8"))
                if saved.get("signature") == sig:
                    rows, names = saved["rows"], saved["names"]
            except (OSError, ValueError, KeyError):
                pass
        if rows is None:
            rows, names = _scan(game_path)
            cache.write_text(json.dumps({"signature": sig, "rows": rows, "names": names},
                                        separators=(",", ":")), encoding="utf-8")
        rig = _build_map(rows, names)
        with _lock:
            _state.update(sig=sig, map=rig, error=None)
    except Exception as exc:  # noqa: BLE001 - reported to the page as a status
        with _lock:
            _state.update(error=str(exc))
    finally:
        with _lock:
            _state["building"] = False


def rig_map(game_path: Path, *, start: bool = True) -> RigMap | None:
    """The install's rig map, or None while it is still being built (in the background)."""
    with _lock:
        current = _state["map"]
        if current is not None and _state["sig"] and _state["sig"][1] == str(game_path):
            return current
        if _state["building"] or not start:
            return None
        _state.update(building=True, error=None)
    threading.Thread(target=_load_or_build, args=(game_path,), daemon=True,
                     name="blueprint-rig-index").start()
    return None


def index_status() -> dict:
    with _lock:
        return {"ready": _state["map"] is not None, "building": _state["building"],
                "error": _state["error"],
                "creatures": len(_state["map"].creatures) if _state["map"] else 0}


_STYLE_RE = re.compile(r"\[[^\]]*\]")
_TIER_RE = re.compile(r"_lvl\d+")


def _known(basename: str, rig: RigMap) -> str | None:
    if basename in rig.by_blueprint:
        return basename
    seen = {basename}
    for cand in (_STYLE_RE.sub("", basename), _TIER_RE.sub("", basename),
                 _TIER_RE.sub("", _STYLE_RE.sub("", basename))):
        cand = cand.strip().strip("_")
        if cand and cand not in seen:
            seen.add(cand)
            if cand in rig.by_blueprint:
                return cand
    return None


def resolve(rig: RigMap, part_basenames: list[str]) -> tuple[str | None, dict[str, str]]:
    """Which creature a mod's parts belong to: ``(skeleton, {basename: AP})``."""
    hits = {}
    for b in part_basenames:
        key = _known(b, rig)
        if key is not None:
            hits[b] = rig.by_blueprint[key]
    if not hits:
        return None, {}
    skeleton = Counter(skel for skel, _ap in hits.values()).most_common(1)[0][0]
    return skeleton, {b: ap for b, (skel, ap) in hits.items() if skel == skeleton}


def _scales(rig: RigMap, skeleton, attach, owners) -> Scales:
    heads = Counter(rig.head_scale.get(prefab, 1.0) for prefab, _key in owners.values())
    parts = {}
    for b, (prefab, key) in owners.items():
        ap = attach.get(b)
        if ap is not None:
            parts[b] = assembly.scale_for(ap, skeleton, rig.head_scale.get(prefab, 1.0),
                                          rig.mesh_scale.get((prefab, key), 1.0))
    return Scales(head=heads.most_common(1)[0][0] if heads else 1.0, parts=parts)


def scales_for(rig: RigMap, attach: dict[str, str], skeleton: str | None) -> Scales:
    owners = {}
    for b in attach:
        key = _known(b, rig)
        if key is not None:
            owners[b] = (rig.owner[key], key)
    return _scales(rig, skeleton, attach, owners)


def creature_scales(rig: RigMap, prefab: str) -> Scales:
    found = rig.creatures.get(prefab)
    if not found:
        return Scales()
    skeleton, parts = found
    return _scales(rig, skeleton, parts, {b: (prefab, b) for b in parts})


def prefab_path(rig: RigMap, name: str) -> tuple[str | None, list[str]]:
    want = (name or "").replace("\\", "/").strip().lstrip("/").lower()
    if not want:
        return None, []
    if not want.endswith(".binfab"):
        want += ".binfab"
    found = rig.by_path.get(want) or rig.by_path.get("prefabs/" + want)
    if found:
        return found, []
    if "/" in want:
        return None, []
    candidates = rig.by_stem.get(want[: -len(".binfab")]) or []
    if len(candidates) == 1:
        return candidates[0], []
    return None, sorted(candidates)


# --- search ----------------------------------------------------------------- #

_TYPE_RULES = (
    ("magrider", "magrider"), ("/boat", "boat"), ("wing", "wings"), ("dragon", "dragon"),
    ("/mount", "mount"), ("/skin", "skin"), ("costume", "skin"), ("/style", "style"),
    ("/pet", "ally"), ("companion", "ally"), ("_npc", "ally"), ("/npc", "npc"),
)


def creature_type(prefab: str) -> str:
    low = prefab.lower()
    for needle, kind in _TYPE_RULES:
        if needle in low:
            return kind
    return "other"


def _pretty(prefab: str) -> str:
    return prefab_stem(prefab).replace("_", " ").strip().title()


def search(rig: RigMap, q: str, kind: str = "", limit: int = 60) -> tuple[list[dict], int]:
    """Openable creatures whose name or file name contains every word of ``q``."""
    words = [w for w in (q or "").lower().split() if w]
    hits = []
    for prefab, (skeleton, parts) in rig.creatures.items():
        t = creature_type(prefab)
        if kind and t != kind:
            continue
        name = rig.names.get(prefab) or _pretty(prefab)
        hay = f"{name} {prefab_stem(prefab)}".lower()
        if words and not all(w in hay for w in words):
            continue
        starts = bool(words) and name.lower().startswith(words[0])
        hits.append((not starts, name.lower(), prefab, {
            "path": prefab, "name": name, "codex_type": t,
            "parts": len(parts), "animated": bool(assembly.animations_for(skeleton)),
        }))
    hits.sort(key=lambda h: h[:3])
    return [h[3] for h in hits[:limit]], len(hits)


# --- the specular atlas ----------------------------------------------------- #

_brdf: dict = {}


def _png(width: int, height: int, rgb_rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))
    raw = b"".join(b"\x00" + row for row in rgb_rows)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def dds_to_png(dds: bytes) -> bytes:
    """The top mip of an uncompressed 32-bit DDS as an RGB PNG."""
    if dds[:4] != b"DDS " or len(dds) < 128:
        raise ValueError("not a DDS file")
    height, width = struct.unpack_from("<II", dds, 12)
    pf_flags, fourcc, bits = struct.unpack_from("<I4sI", dds, 80)
    masks = struct.unpack_from("<4I", dds, 92)
    if fourcc not in (b"\x00\x00\x00\x00", b"DX10") and pf_flags & 0x4:
        raise ValueError(f"compressed DDS ({fourcc!r}) isn't supported")
    start = 148 if fourcc == b"DX10" else 128
    if bits not in (0, 32):
        raise ValueError(f"{bits}-bit DDS isn't supported")
    shifts = [((m & -m).bit_length() - 1) if m else s for m, s in zip(masks[:3], (16, 8, 0))]
    rows = []
    for y in range(height):
        row = bytearray()
        base = start + y * width * 4
        for x in range(width):
            px = struct.unpack_from("<I", dds, base + x * 4)[0]
            row += bytes(((px >> shifts[0]) & 255, (px >> shifts[1]) & 255, (px >> shifts[2]) & 255))
        rows.append(bytes(row))
    return _png(width, height, rows)


def brdf_png(game_path: Path) -> bytes | None:
    key = str(game_path)
    if key not in _brdf:
        raw = read_game_file(game_path, "textures/brdfmap.dds")
        _brdf[key] = dds_to_png(raw) if raw else None
    return _brdf[key]
