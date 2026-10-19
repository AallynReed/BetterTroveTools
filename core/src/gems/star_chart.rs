//! backend/gems_and_builds/star_chart.py: star chart layout and saved templates.

use std::time::SystemTime;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::arity;
use super::py;
use super::simulator::{storage_get, storage_set};
use crate::storage::{read_storage, write_storage};
use crate::{ctx, Cmd, Resp};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("get_calculated_star_chart", |a| {
            arity(a, "get_calculated_star_chart", &[], 0)?;
            Ok(get_calculated_star_chart())
        }),
        Cmd::std("save_star_chart_template", |a| {
            arity(a, "save_star_chart_template", &["name", "base64_code"], 2)?;
            Ok(guarded(save_template(a.get(0), a.get(1)), "STAR_CHART_SAVE_TEMPLATE_FAILED"))
        }),
        Cmd::std("get_star_chart_templates", |a| {
            arity(a, "get_star_chart_templates", &[], 0)?;
            Ok(get_templates())
        }),
        Cmd::std("delete_star_chart_template", |a| {
            arity(a, "delete_star_chart_template", &["name"], 1)?;
            Ok(guarded(delete_template(a.get(0)), "STAR_CHART_DELETE_TEMPLATE_FAILED"))
        }),
    ]
}

fn guarded(result: Result<Value, String>, code: &str) -> Value {
    result.unwrap_or_else(|e| Resp::fail(e, code).into())
}

const ORIGIN: (f64, f64) = (500.0, 500.0);

fn radians(deg: f64) -> f64 {
    deg * (std::f64::consts::PI / 180.0)
}

fn rotate(origin: (f64, f64), point: (f64, f64), angle: f64) -> (f64, f64) {
    let ((ox, oy), (px, py)) = (origin, point);
    let qx = ox + angle.cos() * (px - ox) - angle.sin() * (py - oy);
    let qy = oy + angle.sin() * (px - ox) + angle.cos() * (py - oy);
    (qx, qy)
}

fn set_coords(node: &mut Value, p: (f64, f64)) {
    if let Some(obj) = node.as_object_mut() {
        obj.insert("Coords".into(), json!([py::float(p.0), py::float(p.1)]));
    }
}

fn read_coords(node: &Value) -> (f64, f64) {
    let at = |i: usize| node.get("Coords").and_then(|c| c.get(i)).and_then(Value::as_f64).unwrap_or(0.0);
    (at(0), at(1))
}

fn has_stars(node: &Value) -> bool {
    node.get("Stars").is_some_and(crate::args::truthy)
}

fn build_branch(back_rotate: f64, last: (f64, f64), distance: f64, stars: &mut [Value]) {
    const TOTAL_ANGLE: f64 = 193.0;
    let division = TOTAL_ANGLE / (stars.len() + 1) as f64;
    for (i, child) in stars.iter_mut().enumerate() {
        let final_rotation = division * (i + 1) as f64 + back_rotate;
        let rotated = rotate(last, (last.0 - distance, last.1), radians(final_rotation));
        set_coords(child, rotated);
        if has_stars(child) {
            if let Some(Value::Array(kids)) = child.get_mut("Stars") {
                build_branch(-((TOTAL_ANGLE / 2.0) - final_rotation), rotated, distance, kids);
            }
        }
    }
}

fn rotate_branch(star: &mut Value, angle: f64) {
    if !has_stars(star) {
        return;
    }
    if let Some(Value::Array(kids)) = star.get_mut("Stars") {
        for child in kids {
            let p = rotate(ORIGIN, read_coords(child), angle);
            set_coords(child, p);
            rotate_branch(child, angle);
        }
    }
}

/// The layout is a pure function of star_chart.json, so it is kept until the file changes.
static CHART_CACHE: Mutex<Option<(Option<SystemTime>, Value)>> = Mutex::new(None);

fn calculate(path: &std::path::Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("[Errno 2] No such file or directory: {}", py::str_repr(&crate::paths::display(path))),
        _ => e.to_string(),
    })?;
    let mut chart: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    const POINT_DISTANCE: f64 = 60.0;
    const DISTANCE: f64 = 47.0;
    for (i, (name, back)) in [("Combat", 0.0), ("Gathering", -2.0), ("Pve", -4.0)].into_iter().enumerate() {
        let Some(constell) = chart.get_mut(name) else { continue };
        let branch_rotation = 360.0 / 3.0 * i as f64;
        let position = (ORIGIN.0, ORIGIN.1 - POINT_DISTANCE);
        set_coords(constell, rotate(ORIGIN, position, radians(branch_rotation)));
        if let Some(Value::Array(stars)) = constell.get_mut("Stars") {
            build_branch(back, position, DISTANCE, stars);
        }
        rotate_branch(constell, radians(branch_rotation));
    }
    Ok(chart)
}

fn get_calculated_star_chart() -> Value {
    let path = ctx().web_path("assets/data/star_chart.json");
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut cache = CHART_CACHE.lock();
    if let Some((cached_mtime, chart)) = cache.as_ref() {
        if *cached_mtime == mtime {
            return Resp::ok(chart.clone()).with("origin", json!([500, 500])).into();
        }
    }
    match calculate(&path) {
        Ok(chart) => {
            *cache = Some((mtime, chart.clone()));
            Resp::ok(chart).with("origin", json!([500, 500])).into()
        }
        Err(e) => Resp::fail(e, "STAR_CHART_CALC_FAILED").into(),
    }
}

/// The JSON object key `json.dump` writes for a dict key.
fn key_of(name: &Value) -> Result<String, String> {
    match name {
        Value::String(s) => Ok(s.clone()),
        Value::Null => Ok("null".into()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Number(_) => Ok(py::repr(name)),
        other => Err(format!("cannot use '{0}' as a dict key (unhashable type: '{0}')", py::type_name(other))),
    }
}

fn save_template(name: &Value, code: &Value) -> Result<Value, String> {
    let mut data = read_storage();
    if data.get("star_chart_templates").is_none() {
        storage_set(&mut data, "star_chart_templates", json!({}))?;
    }
    let key = key_of(name)?;
    match data.get_mut("star_chart_templates") {
        Some(Value::Object(templates)) => {
            templates.insert(key, code.clone());
        }
        Some(Value::Array(_)) => return Err("list indices must be integers or slices, not str".into()),
        Some(other) => return Err(format!("'{}' object does not support item assignment", py::type_name(other))),
        None => {}
    }
    write_storage(&data).map_err(|e| e.to_string())?;
    Ok(Resp::new(true).into())
}

fn get_templates() -> Value {
    match storage_get(&read_storage(), "star_chart_templates") {
        Ok(t) => Resp::ok(t.clone()).with("templates", t).into(),
        Err(e) => Resp::fail(e, "STAR_CHART_GET_TEMPLATES_FAILED").data(json!({})).with("templates", json!({})).into(),
    }
}

fn delete_template(name: &Value) -> Result<Value, String> {
    let mut data = read_storage();
    let removed = match (name, data.get_mut("star_chart_templates")) {
        (Value::String(n), Some(Value::Object(templates))) => templates.shift_remove(n).is_some(),
        _ => false,
    };
    if removed {
        write_storage(&data).map_err(|e| e.to_string())?;
    }
    Ok(Resp::new(true).into())
}
