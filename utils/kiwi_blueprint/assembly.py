"""The rig half of KiwiAPI's ``app/trove/mods_hub/assembly.py`` the editor needs.

The baked rigs ship under ``data/rigs`` - outside ``web/``, which the Android build bundles
and has no editor. The path is resolved at call time: ``main.py`` changes directory after
importing the backend.
"""
from __future__ import annotations

import glob
import json
import os
import re
from functools import cache, lru_cache

_RIG_NAME_RE = re.compile(r"^[a-z0-9_]+$")


def rig_dir() -> str:
    return os.path.abspath(os.path.join("data", "rigs"))


@cache
def head_aps(rig_name: str | None) -> frozenset[str]:
    """Attach points under the skeleton's ``head_JNT`` (head, hat, face, hair)."""
    rig = _rigs().get(rig_name or "")
    bones = (rig or {}).get("bones") or {}
    names, parents = bones.get("names") or [], bones.get("parents") or []
    heads = {i for i, n in enumerate(names) if n.lower() == "head_jnt"}
    out = set()
    for i, name in enumerate(names):
        if not name.lower().startswith("ap_"):
            continue
        j = parents[i]
        while j is not None and 0 <= j < len(names):
            if j in heads:
                out.add(name[3:].lower())
                break
            j = parents[j]
    return frozenset(out)


def scale_for(ap_key: str, rig_name: str | None = None,
              head_scale: float = 1.0, part_scale: float = 1.0) -> float:
    return part_scale * (head_scale if ap_key in head_aps(rig_name) else 1.0)


@lru_cache(maxsize=1)
def _rigs() -> dict:
    out = {}
    for p in glob.glob(os.path.join(rig_dir(), "*.rig.json")):
        name = os.path.basename(p)[:-len(".rig.json")]
        with open(p, encoding="utf-8") as f:
            out[name] = json.load(f)
    return out


def load_animation(skeleton: str, name: str) -> bytes | None:
    """One baked ``TANIM1`` clip, or None. Names are validated (no path traversal)."""
    if not (_RIG_NAME_RE.match(skeleton or "") and _RIG_NAME_RE.match(name or "")):
        return None
    path = os.path.join(rig_dir(), "anim", skeleton, name + ".anim")
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def load_animation_graph(skeleton: str) -> bytes | None:
    """The rig's animation state machine as JSON bytes, or None."""
    if not _RIG_NAME_RE.match(skeleton or ""):
        return None
    path = os.path.join(rig_dir(), "graph", skeleton + ".graph.json")
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def has_baked_rig(name: str) -> bool:
    return name in _rigs()


def has_ap(rig_name: str, ap_key: str) -> bool:
    rig = _rigs().get(rig_name)
    return bool(rig) and ap_key in rig["rest"]


def rig_pose(name: str) -> dict | None:
    rig = _rigs().get(name or "")
    if not rig:
        return None
    return {"voxel_scale": rig["voxel_scale"], "rest": rig["rest"]}


def animations_for(name: str) -> list[str]:
    rig = _rigs().get(name)
    return list(rig.get("animations", {}).keys()) if rig else []
