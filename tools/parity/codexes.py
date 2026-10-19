"""Parity harness for the codexes port (core/src/codexes).

    python tools/parity/codexes.py build <out_dir> <key>... [--game PATH]
        Builds each codex dataset straight from the install and writes
        <key>.data.json / <key>.manifest.json the way codex_cache writes its cache,
        plus <key>.time (seconds). One key per process gives cold timings.

    python tools/parity/codexes.py endpoints <out_file>
        Drives the eel endpoints (get_<key>_data / clear_<key>_cache) through a
        live -> cache -> stale -> clear sequence. Set APPDATA to a temp dir first.

    python tools/parity/codexes.py fixtures [--game PATH]
        Regenerates core/tests/fixtures/codexes: a mini install cut from the real
        one, golden codex outputs built on it, and golden decoder outputs.

    python tools/parity/codexes.py diff <py_dir> <rs_dir>
        Byte-compares every file both directories hold; summarises differences.

Run from the worktree root with the project venv.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
import sys
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

FIXTURES = ROOT / "core" / "tests" / "fixtures" / "codexes"
DEFAULT_GAME = Path(r"C:\Program Files (x86)\Glyph\Games\Trove\Live")
EXTRACT_DIR = Path(r"C:\parity\allies_runtime_cache")
KEYS = ("allies", "badges", "fish", "items", "mementos", "mounts", "recipes", "styles")


def builders():
    from models.trove.prefab_ally import build_allies_dataset
    from models.trove.prefab_badge import build_badges_dataset
    from models.trove.prefab_fish import build_fish_dataset
    from models.trove.prefab_item import build_items_dataset
    from models.trove.prefab_memento import build_mementos_dataset
    from models.trove.prefab_mount import build_mounts_dataset
    from models.trove.prefab_recipe import build_recipes_dataset
    from models.trove.prefab_style import build_styles_dataset
    return {
        "allies": build_allies_dataset,
        "badges": build_badges_dataset,
        "fish": build_fish_dataset,
        "items": build_items_dataset,
        "mementos": build_mementos_dataset,
        "mounts": build_mounts_dataset,
        "recipes": build_recipes_dataset,
        "styles": build_styles_dataset,
    }


def run_builder(key: str, game: Path):
    kwargs = {"game_path": game, "locale": "en"}
    if key == "allies":
        kwargs["extract_dir"] = EXTRACT_DIR
    return asyncio.run(builders()[key](**kwargs))


def dump_data(data) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def write_outputs(out: Path, key: str, data, manifest) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{key}.data.json").write_text(dump_data(data), encoding="utf-8")
    (out / f"{key}.manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def cmd_build(args: list[str]) -> None:
    game = DEFAULT_GAME
    if "--game" in args:
        i = args.index("--game")
        game = Path(args[i + 1])
        del args[i:i + 2]
    out = Path(args[0])
    for key in args[1:]:
        start = time.perf_counter()
        data, manifest = run_builder(key, game)
        elapsed = time.perf_counter() - start
        write_outputs(out, key, data, manifest)
        (out / f"{key}.time").write_text(f"{elapsed:.3f}", encoding="utf-8")
        print(f"{key}: {len(data)} rows in {elapsed:.2f}s")


def mask(value, appdata: str):
    """Replaces run-dependent values so two runs compare."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in ("generated_at", "expires_at") and isinstance(v, (int, float)) and v:
                out[k] = "<time>"
            else:
                out[k] = mask(v, appdata)
        return out
    if isinstance(value, (list, tuple)):
        return [mask(v, appdata) for v in value]
    if isinstance(value, str) and appdata:
        for form in sorted({appdata, str(Path(appdata))}, key=len, reverse=True):
            value = value.replace(form, "<APPDATA>")
    return value


def cmd_endpoints(args: list[str]) -> None:
    out_file = Path(args[0])
    appdata = os.environ.get("APPDATA", "")
    import backend.codexes.allies  # noqa: F401
    import backend.codexes.badges  # noqa: F401
    import backend.codexes.fish  # noqa: F401
    import backend.codexes.items  # noqa: F401
    import backend.codexes.mementos  # noqa: F401
    import backend.codexes.mounts  # noqa: F401
    import backend.codexes.recipes  # noqa: F401
    import backend.codexes.styles  # noqa: F401
    from backend.codexes.codex_cache import REGISTRY

    results = {}
    for key in KEYS:
        codex = REGISTRY[key]
        steps = []
        steps.append(("clear_empty", codex.clear_cache()))
        start = time.perf_counter()
        steps.append(("live", codex.get_data(False, "")))
        steps.append(("live_seconds", round(time.perf_counter() - start, 3)))
        steps.append(("cached", codex.get_data(False, "")))
        manifest_file = codex._manifest_file()
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        manifest["generated_at"] = manifest["generated_at"] - 13 * 3600
        manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        steps.append(("stale", codex.get_data(False, "")))
        codex.lock.acquire()
        codex.lock.release()
        time.sleep(0.2)
        while codex.lock.locked():
            time.sleep(0.1)
        steps.append(("bad_path", codex.get_data(True, r"C:\definitely\not\trove")))
        steps.append(("cleared", codex.clear_cache()))
        results[key] = steps
    timings = {key: dict(steps)["live_seconds"] for key, steps in results.items()}
    for steps in results.values():
        steps[:] = [s for s in steps if s[0] != "live_seconds"]
    out_file.write_text(json.dumps({"timings": timings, "results": mask(results, appdata)}, indent=2), encoding="utf-8")
    print(json.dumps(timings, indent=2))


# --- fixtures ------------------------------------------------------------------------

def _sanitize(value):
    """NaN/Infinity become strings so the goldens are plain JSON."""
    if isinstance(value, float) and not math.isfinite(value):
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if isinstance(value, dict):
        return {(str(k) if not isinstance(k, str) else k): _sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(v) for v in value]
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, Path):
        return str(value)
    return value


def _uleb(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _write_archive(folder: Path, files: list[tuple[str, bytes]]) -> None:
    """One index.tfi + archive0.tfa holding `files` (names relative to `folder`)."""
    folder.mkdir(parents=True, exist_ok=True)
    blob = bytearray()
    index = bytearray()
    for name, content in files:
        raw = name.encode("ascii")
        index += _uleb(len(raw)) + raw + _uleb(0) + _uleb(len(blob)) + _uleb(len(content)) + _uleb(0)
        blob += content
    (folder / "index.tfi").write_bytes(bytes(index))
    # Like the game's own archives: a sync flush, no final block.
    packer = zlib.compressobj(9)
    (folder / "archive0.tfa").write_bytes(packer.compress(bytes(blob)) + packer.flush(zlib.Z_SYNC_FLUSH))


def _pick(paths: list[str], count: int) -> list[str]:
    if len(paths) <= count:
        return paths
    step = len(paths) / count
    return [paths[int(i * step)] for i in range(count)]


def cmd_fixtures(args: list[str]) -> None:
    from models.trove.prefab_ally import (
        _load_index,
        _normalize_blueprint_lookup_key,
        clean_localized_text,
        read_archive_content,
        read_varint,
    )
    from utils.prefab_binfab import extract_strings

    game = Path(args[args.index("--game") + 1]) if "--game" in args else DEFAULT_GAME
    prefab_entries, _ = _load_index(game / "prefabs")
    by_path = {}
    for tfi, full, entry in prefab_entries:
        by_path.setdefault(full.lower(), (tfi, full, entry))

    def content_of(full_lower: str) -> bytes:
        tfi, _full, entry = by_path[full_lower]
        archive = read_archive_content(tfi.parent / f"archive{entry['archive_index']}.tfa")
        return archive[entry["offset"]: entry["offset"] + entry["size"]]

    def small(prefix: str, limit: int, exclude: str = "") -> list[str]:
        return sorted(
            p for p, (_t, _f, e) in by_path.items()
            if p.startswith(prefix) and p.endswith(".binfab") and e["size"] <= limit
            and not (exclude and p.endswith(exclude))
        )

    chosen: dict[str, bytes] = {}

    def add(path: str, content: bytes | None = None) -> None:
        if path in by_path and path not in chosen:
            chosen[path] = content if content is not None else content_of(path)

    for fixed in (
        "collections/collection_pet.binfab",
        "collections/collection_mount.binfab",
        "collections/collection_memento.binfab",
        "collections/collection_badge.binfab",
        "meta/multipliers.binfab",
        "meta/geode_multipliers.binfab",
        "fish/fish.binfab",
        "meta/fishing/fishweightdata.binfab",
    ):
        add(fixed)
    add("collections/collection_recipe.binfab", content_of("collections/collection_recipe.binfab")[:24000])

    pets = _pick(small("collections/pet/", 6000, "_npc.binfab"), 24)
    for p in pets:
        add(p)
        stem = p.rsplit("/", 1)[-1]
        for variant in (f"item/pet/{stem}", f"item/pet/{stem[:-7]}_trade.binfab"):
            add(variant)
        for s in extract_strings(chosen[p]):
            if "abilities/" in s["text"].lower():
                add(f"{s['text'].lower()}.binfab")
    for p in _pick(small("collections/mount/", 6000), 16):
        add(p)
        stem = p.rsplit("/", 1)[-1]
        add(f"item/mount/{stem}")
    for p in _pick(small("item/unlocker/delve/", 4000), 12) + _pick(small("item/unlocker/", 3000), 8):
        add(p)
    for p in _pick(small("collections/badge/", 3000), 12):
        add(p)
    for p in _pick(small("item/fish/", 3000), 12):
        add(p)
    for p in _pick(small("equipment/", 3000), 16):
        add(p)
    recipes = _pick(small("recipes/", 3000), 24)
    for p in recipes:
        add(p)
        for s in extract_strings(chosen[p]):
            text = s["text"].strip().lower()
            add(f"{text}.binfab")
    for p in sorted(by_path):
        if ("interact" in p or "profession" in p) and p.endswith(".binfab") and by_path[p][2]["size"] < 4000:
            text = content_of(p).lower()
            if any(r.rsplit("/", 1)[-1].removesuffix(".binfab").encode() in text for r in recipes):
                add(p)
                if sum(1 for c in chosen if "interact" in c or "profession" in c) >= 4:
                    break
    for p in list(chosen):
        if p.startswith(("item/", "recipes/")):
            for s in extract_strings(chosen[p]):
                text = s["text"].strip().lower()
                if text.startswith("collections/"):
                    add(f"{text}.binfab")

    out = FIXTURES
    if out.exists():
        shutil.rmtree(out)
    game_out = out / "game"
    # Two indexes, so the per-folder path prefix is exercised.
    root_files = sorted((p, c) for p, c in chosen.items() if not p.startswith("collections/"))
    coll_files = sorted((p.removeprefix("collections/"), c) for p, c in chosen.items() if p.startswith("collections/"))
    _write_archive(game_out / "prefabs", [(by_path[p][1], c) for p, c in root_files])
    _write_archive(game_out / "prefabs" / "collections", coll_files)

    haystack = b"\n".join(chosen.values()).lower().decode("latin1")
    keys_of_interest = [p.rsplit("/", 1)[-1].removesuffix(".binfab") for p in pets]
    lang_entries, _ = _load_index(game / "languages" / "en")
    spans = bytearray()
    for tfi, _full, entry in lang_entries:
        content = read_archive_content(tfi.parent / f"archive{entry['archive_index']}.tfa")[
            entry["offset"]: entry["offset"] + entry["size"]]
        cursor = 0
        while True:
            start = content.find(b"$", cursor)
            if start < 0:
                break
            end = start + 1
            while end < len(content) and (chr(content[end]).isalnum() and content[end] < 128 or content[end] in (95, 36)):
                end += 1
            if end >= len(content) or content[end] != 0x18:
                cursor = start + 1
                continue
            length, value_start = read_varint(content, end + 1)
            if length is None or value_start + length > len(content):
                cursor = start + 1
                continue
            raw_key = content[start:end]
            key = clean_localized_text(raw_key.decode("ascii", errors="ignore"))
            lowered = key.lower().lstrip("$")
            if lowered and (
                lowered in haystack
                or key.startswith("$DelveTier_")
                or any(k and k in lowered for k in keys_of_interest)
            ):
                spans += content[start: value_start + length]
            cursor = value_start + length
    _write_archive(game_out / "languages" / "en", [("prefabs_fixture.binfab", bytes(spans))])

    blueprint_entries, _ = _load_index(game / "blueprints")
    refs = set()
    for content in chosen.values():
        for s in extract_strings(content):
            key = _normalize_blueprint_lookup_key(s["text"])
            if len(key) >= 5:
                refs.add(key)
    picked = []
    for i, (_tfi, full, _e) in enumerate(blueprint_entries):
        if not full.lower().endswith(".blueprint"):
            continue
        key = _normalize_blueprint_lookup_key(Path(full.removesuffix(".blueprint")).name.lower())
        if key in refs or any(key.startswith(r) for r in refs if len(r) >= 8) or i % 997 == 0:
            picked.append(full)
    _write_archive(game_out / "blueprints", [(name, b"") for name in picked])

    golden = out / "golden"
    golden.mkdir(parents=True)
    for key in KEYS:
        data, manifest = run_builder(key, game_out)
        manifest = {**manifest, "game_path": "<GAME>"}
        write_outputs(golden, key, data, manifest)

    from models.trove.prefab_ally import decode_known_power_rank, extract_localization_map, parse_item_pet_signature
    from models.trove.prefab_recipe import decode_quantified_recipe_paths, recipe_mastery_from_prefab
    from utils import binfab_decoder, binfab_reader
    from utils.prefab_binfab import parse_binfab_content

    decoder_files = [p for p in sorted(chosen) if len(chosen[p]) <= 2500]
    decoder_files = _pick(decoder_files, 9) + ["meta/fishing/fishweightdata.binfab"]
    goldens = {}
    for path in decoder_files:
        content = chosen[path]
        fields, end = binfab_reader.parse_flat(content)
        goldens[path] = {
            "parse_binfab": parse_binfab_content(content, path),
            "parse_binfab_collection": parse_binfab_content(content, path, collection_fallbacks=True),
            "harvest": binfab_reader.harvest_strings(content),
            "flat": {"fields": fields, "end": end},
            "message": binfab_reader.parse_message(content),
            "identity": binfab_reader.decode_identity(content),
            "collection": binfab_reader.parse_collection_table(content),
            "tokens": binfab_decoder.analyze_binfab(content, path),
            "power_rank": decode_known_power_rank(content),
            "signature": parse_item_pet_signature(content),
            "quantified": decode_quantified_recipe_paths(content),
            "recipe_mastery": recipe_mastery_from_prefab(content),
        }
    goldens["languages/prefabs_fixture.binfab"] = {"localization": extract_localization_map(bytes(spans))}
    (golden / "decoders.json").write_text(dump_data(_sanitize(goldens)), encoding="utf-8")
    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"{len(chosen)} prefabs, {len(picked)} blueprints, {len(spans)} language bytes; fixtures {total / 1024:.0f} KiB")


def cmd_diff(args: list[str]) -> None:
    a_dir, b_dir = Path(args[0]), Path(args[1])
    failures = 0
    for a in sorted(a_dir.glob("*.json")):
        b = b_dir / a.name
        if not b.exists():
            continue
        if a.read_bytes() == b.read_bytes():
            print(f"identical  {a.name}")
            continue
        failures += 1
        da, db = json.loads(a.read_text(encoding="utf-8")), json.loads(b.read_text(encoding="utf-8"))
        diffs = []
        _walk_diff(da, db, "$", diffs)
        print(f"DIFFERENT  {a.name}: {len(diffs)} difference(s)")
        for line in diffs[:15]:
            print("   ", line)
    sys.exit(1 if failures else 0)


def _walk_diff(a, b, path, out, limit=200):
    if len(out) >= limit:
        return
    if type(a) is not type(b):
        out.append(f"{path}: type {type(a).__name__} {a!r:.80} != {type(b).__name__} {b!r:.80}")
        return
    if isinstance(a, dict):
        if list(a) != list(b):
            missing, extra = [k for k in a if k not in b], [k for k in b if k not in a]
            if missing or extra:
                out.append(f"{path}: keys missing {missing[:5]} extra {extra[:5]}")
            else:
                out.append(f"{path}: key order differs")
        for k in a:
            if k in b:
                _walk_diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: len {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            _walk_diff(x, y, f"{path}[{i}]", out, limit)
    elif a != b:
        out.append(f"{path}: {a!r:.120} != {b!r:.120}")


if __name__ == "__main__":
    command, rest = sys.argv[1], sys.argv[2:]
    {"build": cmd_build, "endpoints": cmd_endpoints, "fixtures": cmd_fixtures, "diff": cmd_diff}[command](rest)
