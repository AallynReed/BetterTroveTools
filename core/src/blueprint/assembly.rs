//! utils/kiwi_blueprint/assembly.py: the baked rigs under `data/rigs` (rest poses,
//! sockets, clips and animation graphs).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::Value;

use super::pyobj::{self, Py};

pub struct Rig {
    pub voxel_scale: Value,
    pub rest: Value,
    pub animations: Vec<String>,
    /// Sockets under the skeleton's `head_JNT`, which take the creature's head scale.
    head_aps: HashSet<String>,
}

impl Rig {
    pub fn has_ap(&self, ap: &str) -> bool {
        self.rest.as_object().is_some_and(|r| r.contains_key(ap))
    }

    pub fn ap_keys(&self) -> impl Iterator<Item = &str> {
        self.rest.as_object().into_iter().flat_map(|r| r.keys().map(String::as_str))
    }
}

fn rig_dir() -> PathBuf {
    crate::ctx().resource("data/rigs")
}

fn head_aps(rig: &Py) -> HashSet<String> {
    let bones = rig.get("bones").filter(|b| b.truthy());
    let list = |k: &str| match bones.and_then(|b| b.get(k)) {
        Some(Py::List(v)) => v.clone(),
        _ => Vec::new(),
    };
    let names: Vec<String> = list("names").iter().map(Py::str).collect();
    let parents: Vec<Option<i128>> = list("parents").iter().map(|p| p.int().ok().filter(|_| !matches!(p, Py::None))).collect();
    let heads: HashSet<usize> = names.iter().enumerate().filter(|(_, n)| n.to_lowercase() == "head_jnt").map(|(i, _)| i).collect();
    let mut out = HashSet::new();
    for (i, name) in names.iter().enumerate() {
        if !name.to_lowercase().starts_with("ap_") {
            continue;
        }
        let mut j = parents.get(i).copied().flatten();
        // Bounded walk: a well-formed skeleton reaches its root well within this.
        for _ in 0..=names.len() {
            let Some(at) = j.filter(|&j| j >= 0 && (j as usize) < names.len()) else { break };
            if heads.contains(&(at as usize)) {
                out.insert(name.chars().skip(3).collect::<String>().to_lowercase());
                break;
            }
            j = parents.get(at as usize).copied().flatten();
        }
    }
    out
}

fn load_rigs() -> HashMap<String, Rig> {
    let mut out = HashMap::new();
    let Ok(dir) = std::fs::read_dir(rig_dir()) else { return out };
    for entry in dir.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let matches = if cfg!(windows) { file.to_lowercase().ends_with(".rig.json") } else { file.ends_with(".rig.json") };
        if !matches || file.starts_with('.') || !entry.path().is_file() {
            continue;
        }
        let Some(rig) = std::fs::read_to_string(entry.path()).ok().and_then(|t| pyobj::loads(&t).ok()) else { continue };
        let value = |k: &str| rig.get(k).and_then(Py::to_value).unwrap_or(Value::Null);
        let animations = match rig.get("animations") {
            Some(Py::Dict(items)) => items.iter().map(|(k, _)| k.clone()).collect(),
            _ => Vec::new(),
        };
        let name = file[..file.len() - ".rig.json".len()].to_string();
        out.insert(name, Rig { voxel_scale: value("voxel_scale"), rest: value("rest"), animations, head_aps: head_aps(&rig) });
    }
    out
}

fn rigs() -> &'static HashMap<String, Rig> {
    static RIGS: OnceLock<HashMap<String, Rig>> = OnceLock::new();
    RIGS.get_or_init(load_rigs)
}

/// `rig_pose` / `_rigs().get(name)`.
pub fn rig(name: &str) -> Option<&'static Rig> {
    rigs().get(name)
}

pub fn has_baked_rig(name: &str) -> bool {
    rigs().contains_key(name)
}

/// `scale_for(ap, rig, head_scale, part_scale)`.
pub fn scale_for(ap: &str, rig_name: Option<&str>, head_scale: f64, part_scale: f64) -> f64 {
    let under_head = rig_name.and_then(rig).is_some_and(|r| r.head_aps.contains(ap));
    part_scale * if under_head { head_scale } else { 1.0 }
}

pub fn animations_for(name: &str) -> &'static [String] {
    rig(name).map(|r| r.animations.as_slice()).unwrap_or(&[])
}

/// `^[a-z0-9_]+$`: no path traversal through a clip or rig name.
fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// One baked `TANIM1` clip.
pub fn load_animation(skeleton: &str, name: &str) -> Option<Vec<u8>> {
    if !valid_name(skeleton) || !valid_name(name) {
        return None;
    }
    let path = rig_dir().join("anim").join(skeleton).join(format!("{name}.anim"));
    path.is_file().then(|| std::fs::read(&path).ok()).flatten()
}

/// The rig's animation state machine, as the JSON bytes on disk.
pub fn load_animation_graph(skeleton: &str) -> Option<Vec<u8>> {
    if !valid_name(skeleton) {
        return None;
    }
    let path = rig_dir().join("graph").join(format!("{skeleton}.graph.json"));
    path.is_file().then(|| std::fs::read(&path).ok()).flatten()
}
