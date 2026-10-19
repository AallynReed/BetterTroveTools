//! utils/kiwi_blueprint/lint.py: the Trove Creations checks (a port of Troxel's lint)
//! run against a compiled blueprint.

use std::collections::{HashSet, VecDeque};

use serde_json::{json, Value};

use super::codec::{self, Decoded, Voxel};
use super::materials;
use super::py;
use super::util::{Cell, FxBuild, OrderedMap};

/// label -> (max_x, max_y, max_z), in `CREATION_TYPES` order.
const DIMENSIONS: [(&str, [i64; 3]); 10] = [
    ("melee", [10, 10, 35]),
    ("gun", [5, 12, 5]),
    ("staff", [12, 12, 35]),
    ("bow", [3, 9, 21]),
    ("fist", [6, 9, 5]),
    ("spear", [11, 11, 45]),
    ("mask", [10, 10, 5]),
    ("hat", [20, 14, 20]),
    ("hair", [20, 14, 20]),
    ("deco", [12, 12, 12]),
];

const NEEDS_ATTACHMENT: [&str; 9] = ["melee", "gun", "staff", "bow", "spear", "fist", "mask", "hat", "hair"];

/// `CREATION_TYPES`.
pub fn creation_types() -> impl Iterator<Item = &'static str> {
    DIMENSIONS.iter().map(|d| d.0).chain(["other"])
}

struct Finding {
    level: &'static str,
    title: String,
    body: String,
    voxels: Vec<usize>,
}

fn finding(level: &'static str, title: impl Into<String>, body: impl Into<String>) -> Finding {
    Finding { level, title: title.into(), body: body.into(), voxels: Vec::new() }
}

fn check_dimensions(kind: &str, size: [i64; 3]) -> Vec<Finding> {
    let Some(&(_, [lx, ly, lz])) = DIMENSIONS.iter().find(|d| d.0 == kind) else { return Vec::new() };
    let [sx, sy, sz] = size;
    let fits = |a: i64, b: i64, c: i64| a <= lx && b <= ly && c <= lz;
    if fits(sx, sy, sz) {
        return Vec::new();
    }
    // Fitting once turned means the fix is a rotation, not a rebuild.
    let rotations = [(sx, sz, sy), (sy, sx, sz), (sy, sz, sx), (sz, sx, sy), (sz, sy, sx)];
    if rotations.iter().any(|&(a, b, c)| fits(a, b, c)) {
        return vec![finding(
            "error",
            "The model is facing the wrong way",
            format!(
                "A {kind} should fit within {lx}x{ly}x{lz}, and yours ({sx}x{sy}x{sz}) would if it were turned. Use the rotate buttons under 'Turn it' - weapons point forward along the long axis, hats point up."
            ),
        )];
    }
    vec![finding("error", "The model is too big", format!("A {kind} should not exceed {lx}x{ly}x{lz} voxels, but yours is {sx}x{sy}x{sz}."))]
}

fn are(n: usize) -> &'static str {
    if n != 1 {
        "s are"
    } else {
        " is"
    }
}

fn check_dark_voxels(voxels: &[Voxel]) -> Vec<Finding> {
    let hits: Vec<usize> = voxels
        .iter()
        .enumerate()
        .filter(|(_, v)| !materials::is_procedural(v.t, v.r, v.g, v.b) && (v.r.min(v.g).min(v.b) as u32 + v.r.max(v.g).max(v.b) as u32) < 20)
        .map(|(i, _)| i)
        .collect();
    if hits.is_empty() {
        return Vec::new();
    }
    vec![Finding {
        level: "error",
        title: format!("{} voxel{} almost black", py::thousands(hits.len() as i64), are(hits.len())),
        body: "Trove's style guide asks for nothing darker than (10, 10, 10) - pure black reads as a hole in game. Use a dark grey instead.".into(),
        voxels: hits,
    }]
}

fn check_floating(cells: &OrderedMap<Cell, usize>) -> Vec<Finding> {
    let Some(&(start, _)) = cells.items.first() else { return Vec::new() };
    let mut seen: HashSet<Cell, FxBuild> = HashSet::with_capacity_and_hasher(cells.len(), FxBuild::default());
    let mut queue = VecDeque::from([start]);
    seen.insert(start);
    while let Some((x, y, z)) = queue.pop_front() {
        for n in [(x + 1, y, z), (x - 1, y, z), (x, y + 1, z), (x, y - 1, z), (x, y, z + 1), (x, y, z - 1)] {
            if cells.contains(&n) && seen.insert(n) {
                queue.push_back(n);
            }
        }
    }
    let stray: Vec<usize> = cells.iter().filter(|(c, _)| !seen.contains(c)).map(|(_, i)| *i).collect();
    if stray.is_empty() {
        return Vec::new();
    }
    vec![Finding {
        level: "warning",
        title: format!("{} voxel{} not connected to the model", py::thousands(stray.len() as i64), are(stray.len())),
        body: "These only touch the rest of the model at a corner, or not at all. Trove renders them, but the style guide asks for face-connected geometry.".into(),
        voxels: stray,
    }]
}

fn check_attachment(kind: &str, attach: Option<[i64; 3]>, size: [i64; 3], cells: &OrderedMap<Cell, usize>) -> Vec<Finding> {
    let mut out = Vec::new();
    let Some([ax, ay, az]) = attach else {
        if NEEDS_ATTACHMENT.contains(&kind) {
            out.push(finding(
                "warning",
                "This model stores no attachment point",
                "Older blueprints (format v3/v4) don't record an origin, so there's nothing to check and nothing to show. The game positions these by other means.",
            ));
        }
        return out;
    };
    let [sx, sy, sz] = size;
    if ["melee", "staff", "bow", "spear", "gun", "fist"].contains(&kind) && !cells.contains(&(ax, ay, az)) {
        out.push(finding(
            "warning",
            "The attachment point isn't on a voxel",
            format!("The hand grips ({ax}, {ay}, {az}), but there's no voxel there. On a weapon the attachment point should sit inside the handle."),
        ));
    }
    if ["melee", "staff", "bow"].contains(&kind) {
        let limit = if kind == "bow" { 3 } else { 4 };
        if ay > limit || sy - ay > 6 {
            out.push(finding(
                "warning",
                "The handle sits too high or too low",
                format!("There shouldn't be more than 5 voxels above or {limit} below the attachment point; yours has {} above and {ay} below.", sy - ay - 1),
            ));
        }
        let blocked: Vec<usize> = cells
            .iter()
            .filter(|((x, y, z), _)| (x - ax).abs() <= 1 && (y - ay).abs() <= 1 && (z - az).abs() <= 1 && !(*x == ax && *y == ay))
            .map(|(_, i)| *i)
            .collect();
        if !blocked.is_empty() {
            let mut f = finding(
                "warning",
                "The grip is crowded",
                "Around the attachment point there should be nothing in a 3x3x3 cube except the handle running lengthwise - that space is the hand.",
            );
            f.voxels = blocked;
            out.push(f);
        }
    }
    if kind == "staff" {
        if !(8..=14).contains(&az) {
            out.push(finding("warning", "The staff handle is the wrong length", format!("The handle behind the attachment point should be 8-14 voxels; yours is {az}.")));
        }
        if sz - az < 17 {
            out.push(finding(
                "warning",
                "The staff head is too close to the grip",
                format!("There should be at least 16 voxels between the attachment point and the tip; yours has {}.", sz - az - 1),
            ));
        }
    }
    if kind == "spear" && !(8..=12).contains(&az) {
        out.push(finding(
            "warning",
            "The spear grip is in the wrong place",
            format!("The attachment point should be 9-13 voxels from the base of the shaft; yours is {}.", az + 1),
        ));
    }
    if kind == "gun" && az != 0 {
        out.push(finding(
            "warning",
            "There's geometry behind the grip",
            format!("A gun's attachment point should sit at the back of the model (z = 0); yours is at z = {az}."),
        ));
    }
    if kind == "hat" || kind == "hair" {
        if ay > -6 {
            out.push(finding(
                "error",
                "The model isn't high enough above its attachment point",
                format!("The attachment point should be at least 6 voxels below the model (the head fills that space); yours is {}.", if ay < 0 { -ay } else { 0 }),
            ));
        }
        if ax > 10 || sx - ax > 10 || az > 9 || sz - az > 11 {
            out.push(finding(
                "warning",
                "The model is off-centre over the head",
                format!(
                    "There shouldn't be more than ~10 voxels to any side of the attachment point; yours reaches {ax} right, {} left, {az} back, {} front.",
                    sx - ax - 1,
                    sz - az - 1
                ),
            ));
        }
    }
    if kind == "mask" {
        if az > -6 {
            out.push(finding(
                "error",
                "The mask isn't far enough in front of its attachment point",
                format!("The attachment point should be 6 voxels behind the mask (that space is the head); yours is {}.", if az < 0 { -az } else { 0 }),
            ));
        }
        if ax > 5 || sx - ax > 5 || ay > 4 || sy - ay > 6 {
            out.push(finding(
                "warning",
                "The mask is off-centre on the face",
                format!(
                    "There shouldn't be more than ~5 voxels to any side of the attachment point; yours reaches {ax} right, {} left, {} up, {ay} down.",
                    sx - ax - 1,
                    sy - ay - 1
                ),
            ));
        }
    }
    out
}

/// `check(decoded, kind)`.
pub fn check(decoded: &Decoded, kind: &str) -> Value {
    let kind = if creation_types().any(|k| k == kind) { kind } else { "other" };
    let voxels = &decoded.voxels;
    let size = decoded.size;
    let attach = codec::attachment_point(decoded);
    let mut cells: OrderedMap<Cell, usize> = OrderedMap::with_capacity(voxels.len());
    for (i, v) in voxels.iter().enumerate() {
        cells.insert((v.x, v.y, v.z), i);
    }

    let mut findings = check_dimensions(kind, size);
    if kind == "spear" && size[2] != 45 {
        findings.push(finding("error", "A spear has to be exactly 45 voxels long", format!("Yours is {}. The game positions the shaft assuming that length.", size[2])));
    }
    if kind == "bow" && 3 < size[0] && size[0] <= 5 {
        findings.push(finding(
            "warning",
            "This bow is thicker than the guidelines allow",
            format!("A bow should be at most 3 voxels thick; yours is {}. Up to 5 is sometimes accepted if the design really needs it.", size[0]),
        ));
    }
    findings.extend(check_dark_voxels(voxels));
    if kind != "deco" {
        findings.extend(check_floating(&cells));
    }
    if !voxels.iter().any(|v| v.t != 21 || v.w != 0) {
        findings.push(finding(
            "info",
            "No materials are used",
            "Every voxel is a plain rough solid. Glass, glowing and the metal/waxy/iridescent finishes are what give a model depth in game - worth trying where they suit the design.",
        ));
    }
    if kind != "other" {
        findings.extend(check_attachment(kind, attach, size, &cells));
    }
    let rank = |l: &str| ["error", "warning", "info"].iter().position(|x| *x == l).unwrap();
    findings.sort_by_key(|f| rank(f.level));

    let mut satisfied = vec!["A blueprint stores one material per voxel, so alpha-on-solid and specular-on-glass - two of the classic .qb mistakes - can't happen here.".to_string()];
    if !findings.iter().any(|f| f.title.ends_with("almost black")) {
        satisfied.push("No near-black voxels.".into());
    }
    if let Some([a, b, c]) = attach.filter(|_| NEEDS_ATTACHMENT.contains(&kind)) {
        satisfied.push(format!("Attachment point recorded at ({a}, {b}, {c})."));
    }
    let count = |l: &str| findings.iter().filter(|f| f.level == l).count();
    json!({
        "kind": kind,
        "attachment": attach,
        "findings": findings.iter().map(|f| json!({"level": f.level, "title": f.title, "body": f.body, "voxels": f.voxels})).collect::<Vec<_>>(),
        "satisfied": satisfied,
        "counts": {"error": count("error"), "warning": count("warning"), "info": count("info")},
    })
}
