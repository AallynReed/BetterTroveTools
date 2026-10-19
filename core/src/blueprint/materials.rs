//! utils/kiwi_blueprint/materials.py and voxel.py's `material_for`: what a voxel's
//! `(type, w)` pair means, which pairs the palette may write, and how it renders.

use std::sync::OnceLock;

use serde_json::{json, Value};

use super::py;
use super::qb;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Solid,
    Glass,
}

impl Class {
    fn name(self) -> &'static str {
        match self {
            Class::Solid => "solid",
            Class::Glass => "glass",
        }
    }
}

/// The five types Trove's UGC pipeline lets a modder author, in palette order.
pub const PALETTE_TYPES: [(u16, &str, Class); 5] =
    [(21, "Solid", Class::Solid), (18, "Glass", Class::Glass), (54, "Tiled Glass", Class::Glass), (55, "Glowing Solid", Class::Solid), (56, "Glowing Glass", Class::Glass)];

const SPECULAR_NAMES: [&str; 6] = ["Rough", "Metal", "Water", "Iridescent", "Waxy", "Wave"];
const NO_SPECULAR_TYPE: u16 = 55;
pub const GLASS_LEVELS: i64 = 8;
pub const PLACEHOLDER_TYPE: u16 = 39;
const AUTHORED_COLOUR_TYPES: [u16; 6] = [21, 18, 54, 55, 56, 24];

fn internal_name(t: u16) -> Option<&'static str> {
    Some(match t {
        1 => "Terrain (dirt)",
        2 => "Terrain (grass)",
        3 => "Terrain (stone)",
        4 => "Terrain (shadow)",
        24 => "Placeable colour",
        28 => "Decorative",
        38 => "Trigger",
        39 => "Deco placeholder",
        59 => "Attachment",
        79 => "Terrain (ice)",
        94 => "Collision",
        100 => "Terrain (snow)",
        174 => "Terrain (lava)",
        _ => return None,
    })
}

fn palette_entry(t: u16) -> Option<(&'static str, Class)> {
    PALETTE_TYPES.iter().find(|p| p.0 == t).map(|p| (p.1, p.2))
}

pub fn alpha_for_w(w: i64) -> i64 {
    16 + 32 * w.clamp(0, GLASS_LEVELS - 1)
}

pub fn is_procedural(t: u16, r: u8, g: u8, b: u8) -> bool {
    !AUTHORED_COLOUR_TYPES.contains(&t) && r.max(g).max(b) <= 24
}

pub fn material_class(t: u16) -> Class {
    palette_entry(t).map(|e| e.1).unwrap_or(Class::Solid)
}

pub fn is_editable(t: u16) -> bool {
    palette_entry(t).is_some()
}

fn opacity_pct(w: i64) -> i64 {
    py::round(alpha_for_w(w) as f64 / 255.0 * 100.0)
}

/// A human label for a `(type, w)` pair.
pub fn describe(t: u16, w: i64) -> String {
    if let Some((label, class)) = palette_entry(t) {
        if class == Class::Glass {
            return format!("{label} - {}% opacity", opacity_pct(w));
        }
        if t == NO_SPECULAR_TYPE {
            return if w == 0 { label.to_string() } else { format!("{label} - unused finish {w}") };
        }
        return match SPECULAR_NAMES.get(w as usize).filter(|_| w >= 0) {
            Some(name) => format!("{label} - {name}"),
            None => format!("{label} - finish {w}"),
        };
    }
    match internal_name(t) {
        Some(name) => format!("{name} (type {t})"),
        None => format!("Unknown type {t}"),
    }
}

/// `validate_material`: clamp an incoming pair to what the palette can express.
pub fn validate_material(t: i128, w: i128) -> Result<(u16, u8), String> {
    let Some(t16) = u16::try_from(t).ok().filter(|&t| is_editable(t)) else {
        return Err(format!("Type {t} is not an editable material."));
    };
    let w = if material_class(t16) == Class::Glass {
        w.clamp(0, GLASS_LEVELS as i128 - 1)
    } else if t16 == NO_SPECULAR_TYPE {
        0
    } else {
        w.clamp(0, SPECULAR_NAMES.len() as i128 - 1)
    };
    Ok((t16, w as u8))
}

fn qb_hex(rgb: Option<(u8, u8, u8)>) -> Value {
    rgb.map(|(r, g, b)| json!(format!("#{r:02x}{g:02x}{b:02x}"))).unwrap_or(Value::Null)
}

/// `palette()`, as JSON text: it never changes.
pub fn palette_json() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        let types: Vec<Value> = PALETTE_TYPES
            .iter()
            .map(|&(t, label, class)| {
                let options: Vec<Value> = if class == Class::Glass {
                    (0..GLASS_LEVELS)
                        .map(|w| {
                            let a = alpha_for_w(w) as u8;
                            json!({"w": w, "label": format!("{}%", opacity_pct(w)), "alpha": a, "qb_map": "_a", "qb": qb_hex(Some((a, a, a)))})
                        })
                        .collect()
                } else if t == NO_SPECULAR_TYPE {
                    vec![json!({"w": 0, "label": SPECULAR_NAMES[0]})]
                } else {
                    SPECULAR_NAMES
                        .iter()
                        .enumerate()
                        .map(|(w, name)| json!({"w": w, "label": name, "qb_map": "_s", "qb": qb_hex(qb::specular_rgb(w as i64))}))
                        .collect()
                };
                json!({"type": t, "label": label, "class": class.name(), "options": options, "qb_map": "_t", "qb": qb_hex(qb::type_index(t).map(qb::type_rgb))})
            })
            .collect();
        crate::json::dumps(&json!({"types": types, "glass_levels": GLASS_LEVELS}))
    })
}

/// voxel.py `material_for`: `(r, g, b, kind code, level, spec)`.
pub fn material_for(r: u8, g: u8, b: u8, w: u8, t: u16) -> (u8, u8, u8, i64, i64, i64) {
    let (mut r, mut g, mut b) = (r, g, b);
    if !AUTHORED_COLOUR_TYPES.contains(&t) && r.max(g).max(b) <= 24 {
        (r, g, b) = match t {
            1 => (150, 130, 100),
            2 => (40, 170, 0),
            3 => (120, 120, 120),
            4 => (110, 78, 165),
            79 => (185, 194, 197),
            100 => (220, 222, 225),
            174 => (232, 33, 70),
            _ => (110, 110, 110),
        };
    }
    // KIND_CODE: S=0, G=1, E=2, GE=3.
    let kind = match t {
        55 => 2,
        56 => 3,
        18 | 54 => 1,
        _ => 0,
    };
    let w = (w as i64).min(7);
    let level = if kind == 1 || kind == 3 { 16 + 32 * w } else { 255 };
    (r, g, b, kind, level, if kind == 0 { w } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(describe(18, 3), "Glass - 44% opacity");
        assert_eq!(describe(21, 9), "Solid - finish 9");
        assert_eq!(describe(55, 2), "Glowing Solid - unused finish 2");
        assert_eq!(describe(39, 0), "Deco placeholder (type 39)");
        assert_eq!(describe(7, 0), "Unknown type 7");
        assert_eq!(validate_material(21, 9), Ok((21, 5)));
        assert_eq!(validate_material(1, 0), Err("Type 1 is not an editable material.".into()));
    }
}
