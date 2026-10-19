"""Golden fixtures for the gems port (core/src/gems).

Run from the repo root with the project venv:

    python tools/parity/gems.py              # rewrite core/tests/fixtures/gems/*.json
    python tools/parity/gems.py --full OUT [N]   # every expected value spelled out (no
                                                 # hashes), N times the random cases, for
                                                 # BTT_GEMS_FIXTURES=OUT

Deterministic endpoints are recorded exactly; big answers as the sha256 of their eel JSON.
Endpoints that roll dice are recorded as every possible outcome (the RNG is patched
to walk each choice), and Gem.create as a distribution summary over many runs.
Everything runs under a throwaway APPDATA.
"""
import contextlib
import hashlib
import json
import os
import random
import sys
import tempfile
from pathlib import Path
from unittest import mock

_SANDBOX = tempfile.mkdtemp(prefix="btt-gems-parity-")
for _key in ("APPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"):
    os.environ[_key] = _SANDBOX
os.environ.pop("BTT_DATA_DIR", None)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import base64  # noqa: E402
import io  # noqa: E402

import models.trove.gems as gems_model  # noqa: E402
from backend.gems_and_builds import gem_builds, gem_evaluator, gem_simulator, star_chart  # noqa: E402
from models.trove.gem_bases import (get_gem_max_level, get_stat_base_empowered, get_stat_base_lesser,  # noqa: E402
                                    get_stat_threshold_empowered, get_stat_threshold_lesser)
from models.trove.gem_constants import GemStatType, GemTier, GemType  # noqa: E402
from utils.helper import get_storage_file  # noqa: E402

FIXTURES = ROOT / "core" / "tests" / "fixtures" / "gems"
HASH_OVER = 1200  # answers longer than this (in JSON) are stored as a sha256
FULL = False
SCALE = 1  # --full OUT N multiplies the random case counts by N

ENDPOINTS = {}
for _mod in (gem_builds, gem_evaluator, gem_simulator, star_chart):
    for _name in dir(_mod):
        _fn = getattr(_mod, _name)
        if callable(_fn) and hasattr(_fn, "__wrapped__"):
            ENDPOINTS[_name] = _fn


def eel_json(value):
    """What eel sent the page: json.dumps with unserialisable values as null."""
    return json.dumps(value, default=lambda o: None)


def call(cmd, *args):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return ENDPOINTS[cmd](*args)


def canon_chart(value):
    """Python's star chart parse iterates a set: sort what that leaves unordered."""
    def fix(d):
        if isinstance(d.get("stats"), dict):
            d["stats"] = dict(sorted(d["stats"].items()))
        if isinstance(d.get("abilities"), list):
            d["abilities"] = sorted(d["abilities"])
    value = json.loads(eel_json(value))
    fix(value)
    if isinstance(value.get("data"), dict):
        fix(value["data"])
    return value


def gem_id(value):
    """Gem.create stamps the clock into `id`."""
    for d in (value, value.get("data", {})):
        if isinstance(d, dict) and isinstance(d.get("gem"), dict):
            d["gem"]["id"] = 0
    return value


def canonical(result, canon):
    if canon == "chart":
        return canon_chart(result)
    value = json.loads(eel_json(result))
    return gem_id(value) if canon == "gem_id" else value


def sha(value):
    return hashlib.sha256(eel_json(value).encode()).hexdigest()


GEM_TABLE = []  # shared gems; case args refer to them as {"$gem": index}


def resolve(value):
    if isinstance(value, dict):
        if set(value) == {"$gem"}:
            return json.loads(json.dumps(GEM_TABLE[value["$gem"]]))
        return {k: resolve(v) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v) for v in value]
    return value


def record(cmd, args, canon=None, keep=0):
    """One case. `keep` spells out the first N builds of a hashed builds answer."""
    value = canonical(call(cmd, *resolve(json.loads(json.dumps(args)))), canon)
    text = eel_json(value)
    case = {"cmd": cmd, "args": args}
    if canon:
        case["canon"] = canon
    if len(text) > HASH_OVER and not FULL:
        case["sha256"] = hashlib.sha256(text.encode()).hexdigest()
        case["success"] = value.get("success")
        if keep and isinstance(value.get("builds"), list):
            case["first_builds"] = value["builds"][:keep]
    else:
        case["expect"] = value
    return case


# --- inputs ------------------------------------------------------------------------------

def stat_value(rng, tier, kind, stat, level, containers):
    """A plausible displayed value for a stat, sometimes nudged out of range."""
    lesser = kind == 1
    base = (get_stat_base_lesser if lesser else get_stat_base_empowered)(GemTier(tier), None, GemStatType(stat))
    lo, hi = (get_stat_threshold_lesser if lesser else get_stat_threshold_empowered)(GemTier(tier), None, GemStatType(stat))
    pr = gem_evaluator._gem_pr_increment_total(GemTier(tier), GemType(kind), level)
    progress = rng.choice([0.0, 1.0, rng.random(), rng.random(), rng.uniform(-0.2, 1.2)])
    value = base * ((lo + (hi - lo) * progress) * containers + pr)
    return round(value, rng.choice([0, 1, 2, 4]))


def random_gem_stats(rng, allow_bad=False):
    tier = rng.randint(1, 4)
    kind = rng.randint(1, 2)
    level = rng.randint(1, get_gem_max_level(GemTier(tier), GemType(kind)))
    pool = [1, 3, 4, 5, 6, 7] if rng.random() < 0.5 else [2, 3, 4, 5, 6, 7]
    if allow_bad and rng.random() < 0.1:
        pool = [1, 2, 3]
    types = rng.sample(pool, 3)
    available = min(level, 15) // 5
    extras = [0, 0, 0]
    for _ in range(available - (1 if rng.random() < 0.15 else 0)):
        extras[rng.randint(0, 2)] += 1
    if allow_bad and rng.random() < 0.15:
        extras[rng.randint(0, 2)] += 1
    stats = []
    for t, e in zip(types, extras):
        value = stat_value(rng, tier, kind, t, level, 1 + e)
        stats.append({"type": t, "value": value, "extra_containers": e})
    return {"tier": tier, "type": kind, "level": level, "stats": stats}


def evaluator_cases(rng):
    cases = []
    for _ in range(70 * SCALE):
        data = random_gem_stats(rng, allow_bad=True)
        data["auto_guess_procs"] = rng.random() < 0.3
        cases.append(record("evaluate_gem", [data]))
    for _ in range(30 * SCALE):
        data = random_gem_stats(rng, allow_bad=True)
        for s in data["stats"]:
            s["extra_containers"] = rng.randint(0, 2)
        cases.append(record("guess_gem_procs", [data]))
    for _ in range(12 * SCALE):
        data = random_gem_stats(rng)
        cases.append(record("guess_gem_stats", [{k: v for k, v in data.items() if k != "stats"} | {"stats": [{"value": s["value"]} for s in data["stats"]]}]))
    for _ in range(30 * SCALE):
        data = random_gem_stats(rng)
        data["level"] = rng.choice([data["level"], 1, rng.randint(1, 40)])
        cases.append(record("simulate_next_focus", [data]))
    for _ in range(40 * SCALE):
        tier, kind = rng.randint(1, 4), rng.randint(1, 2)
        data = {"tier": tier, "type": kind, "stat_type": rng.randint(1, 7), "level": rng.randint(-2, 40), "extra_containers": rng.randint(-1, 3)}
        if rng.random() < 0.4:
            data["element"] = rng.randint(1, 4)
        elif rng.random() < 0.5:
            data["companion_stat_types"] = rng.sample([1, 2, 3, 4, 5, 6, 7, "x", None], 2)
        cases.append(record("get_gem_stat_range", [data]))
    for _ in range(40 * SCALE):
        data = {"level": rng.randint(0, 40), "power_rank": rng.choice([rng.randint(0, 3000), rng.randint(500, 2500)])}
        if rng.random() < 0.3:
            data["tier"] = rng.randint(1, 4)
        if rng.random() < 0.3:
            data["type"] = rng.randint(1, 2)
        cases.append(record("evaluate_gem_simple", [data]))

    good = {"tier": 4, "type": 1, "level": 20, "stats": [{"type": 1, "value": 6000, "extra_containers": 1}, {"type": 3, "value": 80, "extra_containers": 1}, {"type": 4, "value": 9, "extra_containers": 1}]}
    def tweak(**kw):
        d = json.loads(json.dumps(good))
        d.update(kw)
        return d
    def tweak_stat(i, **kw):
        d = json.loads(json.dumps(good))
        d["stats"][i].update(kw)
        return d
    bad = [
        None, [], {}, tweak(stats=[]), tweak(stats=None), tweak(stats=5), tweak(stats="abc"), tweak(stats={"a": 1, "b": 2, "c": 3}),
        tweak(tier=9), tweak(tier="4"), tweak(tier=None), tweak(type=3), tweak(level="abc"), tweak(level=-3), tweak(level=0),
        tweak_stat(1, type=1), tweak_stat(1, type=2), tweak_stat(0, extra_containers=-1), tweak_stat(0, type="1"),
        tweak_stat(0, type=8), tweak_stat(2, type=9), tweak_stat(0, value="x"), tweak_stat(0, value=None),
        tweak_stat(0, extra_containers="2"), tweak_stat(0, extra_containers=2.7), tweak_stat(0, type=1.0),
        tweak(stats=[{"type": 1, "value": 6000}, {"type": 3, "value": 80}, {"type": 4, "value": 9}]),
        tweak(stats=[{"type": 1}, {"type": 3}, {"type": 4}], auto_guess_procs=True),
        tweak(stats=[1, 2, 3]), tweak(stats=[{"type": 1, "value": 1, "extra_containers": 0}, [], {}]),
        tweak(auto_guess_procs=True, level=35), tweak(level=4, stats=[{"type": 7, "value": 300, "extra_containers": 2}, {"type": 3, "value": 80, "extra_containers": 2}, {"type": 2, "value": 9, "extra_containers": 2}]),
    ]
    for d in bad:
        for cmd in ("evaluate_gem", "guess_gem_procs", "simulate_next_focus"):
            cases.append(record(cmd, [d]))
    for d in [None, {}, tweak(stats=[{"value": "3"}, {"value": 5}, {}]), tweak(stats=[{"value": "x"}, {}, {}]), tweak(stats=[1, 2])]:
        cases.append(record("guess_gem_stats", [d]))
    for d in [None, {}, {"stat_type": 8}, {"stat_type": 1, "element": 9}, {"stat_type": 1, "companion_stat_types": "x"},
              {"stat_type": 1, "companion_stat_types": None}, {"stat_type": 1, "companion_stat_types": {"a": 1}}, {"stat_type": "abc"},
              {"stat_type": 3, "tier": 1, "type": 1, "level": 1}, {"stat_type": 1, "tier": 2, "type": 2, "level": 25, "extra_containers": 3}]:
        cases.append(record("get_gem_stat_range", [d]))
    for d in [None, {}, {"level": "x"}, {"level": -15, "power_rank": 0}, {"level": -15, "power_rank": 100}, {"level": 5, "tier": "x"},
              {"level": 5, "tier": 2, "type": "y"}, {"level": 50, "power_rank": 3000}, {"power_rank": 1e3}]:
        cases.append(record("evaluate_gem_simple", [d]))
    for cmd in ("evaluate_gem", "get_gem_lookups"):
        cases.append(record(cmd, []))
        cases.append(record(cmd, [1, 2]))
    return cases


def chart_paths():
    parser = gem_builds.gem_engine().star_parser
    return parser, parser.selectable_paths


def compact_token(path):
    root, *segments = path.split(".")
    return {"combat": "c", "gathering": "g", "pve": "p"}[root] + "".join(segments)


def star_chart_codes(rng):
    parser, paths = chart_paths()
    codes = []
    for _ in range(25 * SCALE):
        picked = rng.sample(paths, rng.randint(1, 30))
        style = rng.choice(["ids", "tokens", "legacy", "v2"])
        if style in ("ids", "v2"):
            ids = sorted(i for i in (parser.path_to_id[p] for p in picked) if i < 256)
            payload = base64.urlsafe_b64encode(bytes(ids)).decode().rstrip("=")
            codes.append(("SC:" if style == "ids" else "v2:") + payload)
        elif style == "tokens":
            codes.append("SC:" + "|".join(compact_token(p) for p in picked))
        else:
            codes.append(base64.b64encode("$".join(picked).encode()).decode())
    bounty = [p for p in paths if parser.node_map[p].get("Name") in ("Bounty Hunt Boon", "Bounty Hunt")]
    for b in bounty:
        ids = [parser.path_to_id[b]]
        codes.append("SC:" + base64.urlsafe_b64encode(bytes(ids)).decode().rstrip("="))
    deep = sorted(i for i in (parser.path_to_id[p] for p in paths if p.count(".") > 4) if i < 256)
    codes.append("SC:" + base64.urlsafe_b64encode(bytes(deep)).decode())
    codes.append("SC:" + base64.urlsafe_b64encode(bytes(range(256))).decode().rstrip("="))
    codes += ["", None, 5, 0, [], ["x"], {"a": 1}, "SC:", "v2:", "SC:|", "SC:!!!", "SC:A", "SC:AB", "SC:_-_-", " SC:AQ ", "SC:AQ==AQ",
              "SC:c a|g0|P|x9|ca0a|", "SC: CA0 |pb", "Y29tYmF0LmE=", "Y29tYmF0LmEkcHZl", "not base64!", "QQ", "QUJD", "Y29t\nYmF0LmE=",
              "w6k=", "/w==", "é", "SC:é", "  ", "v2:AAEC|"]
    return codes


def build_configs(rng):
    classes = [c["value"] for c in gem_builds.get_trove_classes()["data"]]
    foods = list(gem_builds.get_food_data()["data"]) + ["", "nope"]
    allies = list(gem_builds.get_ally_data()["data"]) + ["", "nope"]
    codes = [c for c in star_chart_codes(random.Random(7))[:25]]
    configs = [{}]
    for i in range(36 * SCALE):
        cfg = {
            "build_type": rng.choice(["Light", "Light", "Farm", "Health"]),
            "character": rng.choice(classes),
            "subclass": rng.choice(classes),
            "food": rng.choice(foods),
            "ally": rng.choice(allies),
            "ally_buff": rng.random() < 0.6,
            "high_precision": rng.random() < 0.3,
            "berserker_battler": rng.random() < 0.3,
            "critical_damage_count": rng.randint(0, 3),
            "no_face": rng.random() < 0.3,
            "light": rng.choice([0, 0, 2500, 4000, 6000, 8123]),
            "subclass_active": rng.random() < 0.5,
            "litany": rng.random() < 0.3,
            "bounty_hunt": rng.random() < 0.5,
            "star_chart": rng.choice([None, "", rng.choice(codes), rng.choice(codes)]),
        }
        if cfg["build_type"] == "Farm" and i % 3:
            cfg["build_type"] = "Light"
        configs.append(cfg)
    for sub in ["Bard", "Gunslinger", "Lunar Lancer", "Candy Barbarian", "Ice Sage", "Shadow Hunter", "Boomeranger", "Solarion"]:
        configs.append({"character": "Revenant" if sub != "Ice Sage" else "Chloromancer", "subclass": sub, "subclass_active": True, "light": 0})
    bounty_code = "SC:" + base64.urlsafe_b64encode(bytes([chart_paths()[0].path_to_id["pve.b.0.a.1.a.0"]])).decode().rstrip("=")
    configs += [
        {"character": "Ice Sage", "star_chart": bounty_code, "bounty_hunt": True},
        {"character": "Knight", "star_chart": bounty_code, "bounty_hunt": True, "high_precision": True},
        {"build_type": "Health", "character": "Knight", "light": 3000},
        {"build_type": "Health", "character": "Dracolyte", "high_precision": True},
        {"light": "5", "critical_damage_count": "2", "ally_buff": "yes", "no_face": 1, "food": "fishing_phys_3_base"},
        {"build_type": "Farm", "character": "Vanguardian", "light": 5000, "ally": "phoenix_stars"},
    ]
    bad = [None, [], "x", {"light": 5.5}, {"character": "X"}, {"build_type": "light"}, {"food": 5}, {"ally_buff": "maybe"},
           {"light": None, "food": None, "star_chart": 5}, {"light": "x" * 100}, {"critical_damage_count": [1]}, {"extra": 1}]
    return configs + bad


def builds_cases(rng):
    cases = [record(c, []) for c in ("get_trove_classes", "get_food_data", "get_ally_data")]
    for cfg in build_configs(rng):
        cases.append(record("calculate_gem_builds", [cfg], keep=2))
    for code in star_chart_codes(rng):
        cases.append(record("parse_star_chart_code", [code], canon="chart"))
    cases.append(record("calculate_gem_builds", []))
    cases.append(record("save_gem_builds_csv", ["", "x.csv"]))
    cases.append(record("save_gem_builds_csv", ["   "]))
    cases.append(record("save_gem_builds_csv", [5]))
    return cases


# --- simulator ---------------------------------------------------------------------------

def container(rng, full=False):
    base = rng.choice([rng.random(), 0.0, 1.0, 0.95, rng.random()])
    augs = [{"type": t, "count": rng.choice([0, 0, 1, 2, 5]) if full else 0} for t in (1, 2, 3)]
    if rng.random() < 0.2:
        augs = augs[: rng.randint(0, 2)]
    return {"base": base, "augments": augs}


def random_gem(rng, level=None):
    tier = rng.randint(1, 4)
    kind = rng.randint(1, 2)
    element = rng.randint(1, 4)
    max_level = get_gem_max_level(GemTier(tier), GemType(kind))
    level = level if level is not None else rng.randint(1, max_level)
    pool = [1, 3, 4, 5, 6] if rng.random() < 0.5 else [2, 3, 4, 5, 6]
    types = rng.sample(pool, 3)
    if element == 4:
        types[rng.randint(0, 2)] = 7
    stats = [{"type": t, "containers": [container(rng, rng.random() < 0.5)], "locked": t == 7} for t in types]
    for _ in range(min(level, 15) // 5):
        stats[rng.randint(0, 2)]["containers"].append(container(rng, rng.random() < 0.5))
    gem = {"id": rng.randint(10**10, 10**11), "tier": tier, "type": kind, "element": element, "level": level, "stats": stats,
           "restriction": rng.choice([1, 2]) if kind == 1 else None, "ability": rng.randint(1, 12) if kind == 2 else None,
           "augmentation": rng.choice([None, None, 0.5, 1])}
    return gem


@contextlib.contextmanager
def walk_rng(index):
    """Makes gems.py's randint/choice pick option `index` (and record how many there were)."""
    seen = {"n": 0}
    def randint(a, b):
        seen["n"] = b - a + 1
        return a + min(index, b - a)
    def choice(seq):
        seq = list(seq)
        if not seq:
            raise IndexError("Cannot choose from an empty sequence")
        seen["n"] = len(seq)
        return seq[min(index, len(seq) - 1)]
    with mock.patch.object(gems_model, "randint", randint), mock.patch.object(gems_model, "choice", choice):
        yield seen


def any_of(cmd, args):
    outcomes = []
    i = 0
    while True:
        with walk_rng(i) as seen:
            value = json.loads(eel_json(call(cmd, *resolve(json.loads(json.dumps(args))))))
        if value not in outcomes:
            outcomes.append(value)
        i += 1
        if i >= max(seen["n"], 1):
            break
    if FULL:
        return {"cmd": cmd, "args": args, "any_of": outcomes}
    return {"cmd": cmd, "args": args, "any_of_sha256": [sha(v) for v in outcomes]}


def simulator_cases(rng):
    cases = [record("get_gem_lookups", [])]
    gems = [random_gem(rng) for _ in range(40)]
    GEM_TABLE[:] = gems
    ref = {id(g): {"$gem": i} for i, g in enumerate(gems)}
    for i in range(0, 40, 4):
        cases.append(record("mass_update_gems", [[ref[id(g)] for g in gems[i:i + 4]] + [None]]))
    odd = [
        {"id": 1, "tier": 1, "type": 1, "element": 1, "level": 3, "restriction": None, "stats": [{"type": 1, "containers": [{"base": 0.5}]}] * 3},
        {"id": 1, "tier": 2, "type": 2, "element": 1, "level": 3, "stats": [{"type": 1, "containers": []}, {"type": 3}, {"type": 4}]},
        {"id": 1, "tier": 3, "type": 2, "element": 1, "level": 3, "stats": [{"type": 9, "containers": [{"base": 0.5}]}]},
        {"id": 1, "tier": 1, "type": 2, "element": 1, "level": 2, "stats": [{"type": 1, "containers": [{"base": 2, "augments": []}, {"base": 1, "augments": []}]}]},
        {"id": 1, "tier": 4, "type": 2, "element": 4, "level": 35, "stats": [{"type": 1, "containers": [{"base": 1, "augments": [{"type": 3, "count": 4}]}]}, {"type": 7, "containers": [{"base": 1.5, "augments": []}]}, {"type": 3, "containers": [{"base": 0.2, "augments": [{"type": 2, "count": 1}]}]}]},
        {"id": "12", "tier": "4", "type": 1.0, "element": True, "level": "7", "restriction": "2", "ability": None, "stats": [{"type": "3", "locked": "yes", "containers": [{"base": "0.25", "augments": [{"type": "1", "count": "2"}]}]}], "augmentation": "0.5"},
        {"tier": 9, "type": "x", "element": 0, "level": 1.5, "stats": [{"type": 1, "containers": [{"base": "abc"}, 5]}, 7], "restriction": 3, "ability": 13, "augmentation": []},
        {"tier": 1}, {}, {"id": None, "tier": None, "type": None, "element": None, "level": None, "stats": None, "locked": 1},
        {"id": 1, "tier": 1, "type": 1, "element": 1, "level": 1, "restriction": 1, "stats": [{"type": 1, "containers": {"a": 1}, "locked": [1]}, {"containers": [{"augments": [{"count": 1}, {"type": 4}]}]}]},
        {"id": 1, "tier": 1, "type": 1, "element": 1, "level": 1, "restriction": 1, "stats": [{"type": 1, "containers": [{"base": 0.5, "augments": 5}]}], "x" * 60: "y" * 80},
    ]
    for g in odd:
        cases.append(record("mass_update_gems", [[g]]))
    for v in [None, 5, "ab", {"a": 1}, [[1]], [None, None]]:
        cases.append(record("mass_update_gems", [v]))

    for g in gems[:12]:
        g = json.loads(json.dumps(g))
        if g["level"] + 1 in (5, 10, 15):
            g["level"] += 1
        cases.append(record("level_up_gem", [g]))
    for g in gems[12:20]:
        g = json.loads(json.dumps(g))
        g["level"] = rng.choice([4, 9, 14])
        g["augmentation"] = rng.choice([0.25, 1])
        cases.append(any_of("level_up_gem", [g]))
    maxed = json.loads(json.dumps(gems[0]))
    maxed["level"] = get_gem_max_level(GemTier(maxed["tier"]), GemType(maxed["type"]))
    cases.append(record("level_up_gem", [maxed]))
    cases.append(record("level_up_gem", [None]))
    short = {"id": 1, "tier": 1, "type": 2, "element": 1, "level": 4, "augmentation": 0.5, "stats": [{"type": 1, "containers": [{"base": 0.5}]}]}
    cases.append(any_of("level_up_gem", [short]))

    for g in gems[20:32]:
        for stat in g["stats"]:
            for aug in (1, 2, 3):
                cases.append(record("augment_gem", [ref[id(g)], stat["type"], aug]))
    g = gems[20]
    for stat_id, aug in [(9, 1), (1.0, 1), (True, 1), ("3", 1), (None, 1), (g["stats"][0]["type"], 4), (g["stats"][0]["type"], "1"), (3.5, 1)]:
        cases.append(record("augment_gem", [ref[id(g)], stat_id, aug]))
    full = {"id": 1, "tier": 1, "type": 2, "element": 1, "level": 1, "stats": [{"type": 1, "containers": [{"base": 1}]}, {"type": 3, "containers": [{"base": 1.5}, {"base": 0.6}]}, {"type": 4, "containers": [{"base": 0.9, "augments": []}]}]}
    for stat_id in (1, 3, 4):
        cases.append(record("augment_gem", [full, stat_id, 2]))
    cases.append(record("augment_gem", [full, 4]))

    for g in gems[32:40] + gems[:6]:
        for stat in g["stats"]:
            cases.append(any_of("spark_gem", [ref[id(g)], stat["type"]]))
            cases.append(any_of("flare_gem", [ref[id(g)], stat["type"]]))
    locked = {"id": 1, "tier": 1, "type": 2, "element": 4, "level": 1, "stats": [{"type": 7, "locked": True, "containers": [{"base": 0.5}]}, {"type": 1, "containers": [{"base": 0.5}]}, {"type": 3, "containers": [{"base": 0.5}]}]}
    cases.append(record("spark_gem", [locked, 7]))
    cases.append(record("spark_gem", [locked, 9]))
    cases.append(record("flare_gem", [locked, 7]))
    crowded = {"id": 1, "tier": 1, "type": 1, "restriction": 1, "element": 1, "level": 1, "stats": [{"type": t, "containers": [{"base": 0.5}]} for t in (1, 3, 4, 5, 6)]}
    cases.append(record("spark_gem", [crowded, 1]))
    lone = {"id": 1, "tier": 1, "type": 2, "element": 1, "level": 1, "stats": [{"type": 1, "containers": [{"base": 0.5}, {"base": 0.7}]}]}
    cases.append(record("flare_gem", [lone, 1]))
    empty = {"id": 1, "tier": 1, "type": 2, "element": 1, "level": 1, "stats": [{"type": 1, "containers": []}, {"type": 2, "containers": [{"base": 1}]}]}
    cases.append(record("flare_gem", [empty, 1]))

    fixed = {"type": 1, "tier": 3, "element": 2, "restriction": 1, "level": 12, "augmentation": 0.4, "generation": [1, 3, 4], "procs": [1, 0, 1]}
    for extra in [{}, {"level": 40}, {"level": 3, "procs": []}, {"generation": [7, 3, 4], "element": 4}, {"augmentation": 1, "procs": [0, 0, 3]},
                  {"tier": 1, "level": 30}, {"type": True, "restriction": 2.0}, {"level": 20.0}, {"augmentation": "0.5"}]:
        cases.append(record("create_gem", [fixed | extra], canon="gem_id"))
    for data in [{"foo": 1}, {"element": 9}, {"element": "1"}, {"type": 1, "restriction": 5}, {"type": 3}, {"tier": 7}, {"tier": "4"},
                 {"level": "x"}, {"level": None}, {"generation": [1, 99, 3]}, {"generation": 5}, {"augmentation": "abc"},
                 {"procs": [1.5]}, {"procs": [0, 0, 0, 2]}, {"procs": 3}, {"level": 7.5}, {"level": 7.5, "procs": []},
                 {"type": 1, "generation": [1], "level": 10, "procs": [0, 1]}, "abc", 5]:
        case = record("create_gem", [data], canon="gem_id")
        assert case.get("expect", {}).get("success") is False, (data, case)
        cases.append(case)

    for _ in range(40 * (SCALE - 1)):
        g = random_gem(rng)
        GEM_TABLE.append(g)
        r = {"$gem": len(GEM_TABLE) - 1}
        cases.append(record("mass_update_gems", [[r]]))
        stat = rng.choice(g["stats"])["type"]
        cases.append(record("augment_gem", [r, stat, rng.randint(1, 3)]))
        cases.append(any_of(rng.choice(["spark_gem", "flare_gem"]), [r, stat]))
        up = json.loads(json.dumps(g))
        up["augmentation"] = rng.choice([0.3, 1])
        cases.append(any_of("level_up_gem", [up]))
    return cases


def create_distribution():
    """Summary of Gem.create over many runs per parameter set."""
    sets = [{}, {"tier": 4}, {"type": 1, "level": 20}, {"type": 2, "element": 4, "level": 35}, {"element": 4, "level": 12},
            {"type": 1, "restriction": 2, "level": 5}, {"augmentation": 0.5, "level": 15}]
    out = []
    for params in sets:
        runs = 4000
        counts = {}
        def bump(key):
            counts[key] = counts.get(key, 0) + 1
        bases = []
        for _ in range(runs):
            gem = call("create_gem", dict(params))["gem"]
            summarize(gem, bump, bases)
        out.append({"params": params, "runs": runs, "freq": {k: v / runs for k, v in sorted(counts.items())},
                    "base_mean": sum(bases) / len(bases)})
    return out


def summarize(gem, bump, bases):
    """Must match `summarize` in core/src/gems/tests.rs."""
    bump(f"tier={gem['tier']}")
    bump(f"type={gem['type']}")
    bump(f"element={gem['element']}")
    bump(f"restriction={gem['restriction']}")
    bump(f"ability={gem['ability']}")
    bump(f"level={gem['level']}")
    for i, stat in enumerate(gem["stats"]):
        bump(f"stat={stat['type']}")
        bump(f"stat{i}.containers={len(stat['containers'])}")
        if stat["locked"]:
            bump(f"locked={stat['type']}")
        for c in stat["containers"]:
            bases.append(c["base"])


# --- storage / star chart ------------------------------------------------------------------

def storage_script():
    """A run of storage writes; the Rust test replays it and compares storage.json."""
    steps = [
        ["load_gem_storage", []],
        ["get_star_chart_templates", []],
        ["save_gem_storage", [{"inventory": [{"id": 1, "x": 1.5}], "equipped": [], "toggles": {"a": True}}]],
        ["save_star_chart_template", ["Main", "SC:AQ"]],
        ["save_star_chart_template", ["Alt é", "SC:Ag"]],
        ["save_star_chart_template", [5, "five"]],
        ["save_star_chart_template", ["Main", "SC:Aw"]],
        ["load_gem_storage", []],
        ["get_star_chart_templates", []],
        ["delete_star_chart_template", ["Alt é"]],
        ["delete_star_chart_template", ["missing"]],
        ["delete_star_chart_template", [5]],
        ["save_star_chart_template", [["x"], "bad"]],
        ["save_gem_storage", [None]],
        ["load_gem_storage", []],
        ["get_star_chart_templates", []],
        ["save_star_chart_template", [None, "null key"]],
        ["save_star_chart_template", [True, "true key"]],
        ["save_star_chart_template", [1.5, "float key"]],
        ["save_gem_storage", []],
    ]
    path = get_storage_file()
    if path.exists():
        path.unlink()
    out = []
    for cmd, args in steps:
        value = json.loads(eel_json(call(cmd, *args)))
        out.append({"cmd": cmd, "args": args, "expect": value})
    return {"steps": out, "file": path.read_text(encoding="utf-8")}


def star_chart_layout():
    value = call("get_calculated_star_chart")
    text = eel_json(value)
    coords = {}
    def walk(node):
        if "Path" in node:
            coords[node["Path"]] = list(node["Coords"])
        for child in node.get("Stars", []):
            walk(child)
    for constell in value["data"].values():
        walk(constell)
    return {"sha256": hashlib.sha256(text.encode()).hexdigest(), "origin": value["origin"], "coords": coords}


def round_cases(rng):
    vals = [2.675, 0.125, 0.375, 1.005, 2.5, 3.5, -0.5, -2.675, 0.045, 1e-9, 123456.785, 0.0, -0.0, 1.15, 2.35]
    vals += [rng.uniform(-1000, 1000) for _ in range(200)]
    vals += [round(rng.uniform(0, 100), 3) for _ in range(150)]
    vals += [rng.randint(0, 10**6) / 8 for _ in range(100)]
    vals += [rng.random() for _ in range(100)]
    return [[v, n, round(v, n)] for v in vals for n in (rng.choice([0, 1, 2, 4, 8, 9]),)]


def write(name, data):
    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / name).write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")


def main():
    global FULL, FIXTURES, SCALE
    if len(sys.argv) > 2 and sys.argv[1] == "--full":
        FULL = True
        FIXTURES = Path(sys.argv[2])
        SCALE = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    rng = random.Random(20261019)
    write("round.json", round_cases(rng))
    write("evaluator.json", evaluator_cases(rng))
    write("builds.json", builds_cases(rng))
    sim = simulator_cases(rng)
    write("simulator.json", {"gems": GEM_TABLE, "cases": sim})
    write("create_distribution.json", create_distribution())
    write("storage.json", storage_script())
    write("star_chart_layout.json", star_chart_layout())
    for f in sorted(FIXTURES.glob("*.json")):
        print(f"{f.name}: {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
