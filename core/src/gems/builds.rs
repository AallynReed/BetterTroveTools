//! backend/gems_and_builds/gem_builds.py: the Gem Builds tab.

use anyhow::Result;
use serde_json::{json, Value};

use super::arity;
use super::engine::{engine, BuildConfig};
use crate::{ctx, Args, Cmd, Dialog, Resp};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("get_trove_classes", |a| {
            arity(a, "get_trove_classes", &[], 0)?;
            Ok(get_trove_classes())
        }),
        Cmd::std("get_food_data", |a| {
            arity(a, "get_food_data", &[], 0)?;
            Ok(spread_engine_data(|e| &e.foods, "GET_FOODS_FAILED"))
        }),
        Cmd::std("get_ally_data", |a| {
            arity(a, "get_ally_data", &[], 0)?;
            Ok(spread_engine_data(|e| &e.allies, "GET_ALLIES_FAILED"))
        }),
        Cmd::std("calculate_gem_builds", |a| {
            arity(a, "calculate_gem_builds", &["config_dict"], 1)?;
            Ok(calculate_gem_builds(a.get(0)))
        }),
        Cmd::std("save_gem_builds_csv", save_gem_builds_csv),
        Cmd::std("parse_star_chart_code", |a| {
            arity(a, "parse_star_chart_code", &["base64_code"], 1)?;
            Ok(parse_star_chart_code(a.get(0)))
        }),
    ]
}

const UNAVAILABLE: &str = "Gem engine unavailable.";

fn get_trove_classes() -> Value {
    let Some(engine) = engine() else {
        return Resp::fail(UNAVAILABLE, "ENGINE_NOT_READY").data(json!([])).into();
    };
    let classes: Vec<Value> = engine.classes.iter().map(|(name, cls)| json!({"name": name, "value": cls.name})).collect();
    Resp::ok(json!(classes)).with("classes", json!(classes)).into()
}

/// `resp(True, data=x, **x)` for the food/ally tables.
fn spread_engine_data(pick: fn(&super::engine::Engine) -> &Value, code: &str) -> Value {
    let Some(engine) = engine() else {
        return Resp::fail(UNAVAILABLE, "ENGINE_NOT_READY").data(json!({})).into();
    };
    let data = pick(engine);
    if !data.is_object() {
        let msg = format!("backend.response.resp() argument after ** must be a mapping, not {}", crate::py::type_name(data));
        return Resp::fail(msg, code).data(json!({})).into();
    }
    Resp::ok(data.clone()).spread().into()
}

fn calculate_gem_builds(config: &Value) -> Value {
    let Some(engine) = engine() else {
        return Resp::fail("Engine failed to initialize. Check console for path errors.", "ENGINE_NOT_READY").into();
    };
    match BuildConfig::validate(config).and_then(|c| engine.calculate_builds(&c)) {
        Ok(builds) => Resp::ok(json!({"builds": builds})).with("builds", builds).into(),
        Err(e) => Resp::fail(e, "CALCULATE_GEM_BUILDS_FAILED").into(),
    }
}

/// Native Save As for the CSV export (the page falls back to a download elsewhere).
fn save_gem_builds_csv(a: &Args) -> Result<Value> {
    arity(a, "save_gem_builds_csv", &["csv_text", "default_file_name"], 1)?;
    let csv = match a.get(0) {
        Value::String(s) if !crate::py::strip(s).is_empty() => s.clone(),
        _ => return Ok(Resp::fail("There is nothing to export.", "EMPTY_EXPORT").into()),
    };
    let name = if a.len() < 2 {
        "gem_builds_export.csv".to_string()
    } else if crate::args::truthy(a.get(1)) {
        a.str(1)
    } else {
        "gem_builds_export.csv".to_string()
    };
    let dialog = Dialog::new("Export Gem Builds As...").default_name(&name).filter("CSV Files", &["csv"]).filter("All Files", &["*"]);
    let Some(mut path) = ctx().host().save_file(dialog) else {
        return Ok(json!({"success": false, "canceled": true}));
    };
    if path.extension().is_none() {
        path.set_extension("csv");
    }
    let mut bytes = "\u{feff}".as_bytes().to_vec();
    bytes.extend_from_slice(csv.as_bytes());
    match std::fs::write(&path, bytes) {
        Ok(()) => Ok(json!({"success": true, "path": crate::paths::display(&path)})),
        Err(e) => Ok(Resp::fail(e.to_string(), "SAVE_GEM_BUILDS_CSV_FAILED").into()),
    }
}

fn parse_star_chart_code(code: &Value) -> Value {
    let Some(engine) = engine() else {
        return Resp::fail(UNAVAILABLE, "ENGINE_NOT_READY")
            .data(json!({"stats": {}, "abilities": []}))
            .with("stats", json!({}))
            .with("abilities", json!([]))
            .into();
    };
    Resp::ok(engine.star_parser.parse_build_code(code).json()).spread().into()
}
