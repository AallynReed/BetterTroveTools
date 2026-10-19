//! backend/gems_and_builds/gem_simulator.py: the Gem Simulator's backend.

use anyhow::Result;
use serde_json::{json, Map, Value};

use super::arity;
use super::constants::*;
use super::model::{lookup, Gem};
use super::py;
use crate::storage::{read_storage, write_storage};
use crate::{Args, Cmd, Resp};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("load_gem_storage", |a| {
            arity(a, "load_gem_storage", &[], 0)?;
            Ok(load_gem_storage())
        }),
        Cmd::std("save_gem_storage", |a| {
            arity(a, "save_gem_storage", &["gem_data"], 1)?;
            Ok(guarded(save_gem_storage(a.get(0)), "GEM_STORAGE_SAVE_FAILED"))
        }),
        Cmd::std("get_gem_lookups", |a| {
            arity(a, "get_gem_lookups", &[], 0)?;
            Ok(Resp::ok(lookups()).into())
        }),
        Cmd::std("create_gem", |a| {
            arity(a, "create_gem", &["data"], 1)?;
            Ok(guarded(create_gem(a.get(0)), "GEM_CREATE_FAILED"))
        }),
        Cmd::std("mass_update_gems", |a| {
            arity(a, "mass_update_gems", &["gem_data"], 1)?;
            Ok(guarded(mass_update_gems(a.get(0)), "GEM_MASS_UPDATE_FAILED"))
        }),
        Cmd::std("level_up_gem", |a| {
            arity(a, "level_up_gem", &["gem_data"], 1)?;
            Ok(guarded(level_up_gem(a.get(0)), "GEM_LEVEL_UP_FAILED"))
        }),
        Cmd::std("augment_gem", |a| {
            arity(a, "augment_gem", &["gem_data", "stat_id", "augment_id"], 3)?;
            Ok(guarded(augment_gem(a), "GEM_AUGMENT_FAILED"))
        }),
        Cmd::std("spark_gem", |a| {
            arity(a, "spark_gem", &["gem_data", "stat_id"], 2)?;
            Ok(guarded(spark_gem(a), "GEM_REROLL_FAILED"))
        }),
        Cmd::std("flare_gem", |a| {
            arity(a, "flare_gem", &["gem_data", "stat_id"], 2)?;
            Ok(guarded(flare_gem(a), "GEM_MOVE_PROC_FAILED"))
        }),
    ]
}

fn guarded(result: Result<Value, String>, code: &str) -> Value {
    result.unwrap_or_else(|e| Resp::fail(e, code).into())
}

/// `storage.get(key, default)` on whatever storage.json held.
pub(super) fn storage_get(storage: &Value, key: &str) -> Result<Value, String> {
    match storage {
        Value::Object(map) => Ok(map.get(key).cloned().unwrap_or_else(|| json!({}))),
        other => Err(format!("'{}' object has no attribute 'get'", py::type_name(other))),
    }
}

/// `storage[key] = value`.
pub(super) fn storage_set(storage: &mut Value, key: &str, value: Value) -> Result<(), String> {
    match storage {
        Value::Object(map) => {
            map.insert(key.to_string(), value);
            Ok(())
        }
        Value::Array(_) => Err("list indices must be integers or slices, not str".into()),
        other => Err(format!("'{}' object does not support item assignment", py::type_name(other))),
    }
}

fn load_gem_storage() -> Value {
    match storage_get(&read_storage(), "gem_simulator") {
        Ok(data) => Resp::ok(data.clone()).with("gem_simulator", data).into(),
        Err(e) => Resp::fail(e, "GEM_STORAGE_LOAD_FAILED").data(json!({})).with("gem_simulator", json!({})).into(),
    }
}

fn save_gem_storage(data: &Value) -> Result<Value, String> {
    let mut storage = read_storage();
    storage_set(&mut storage, "gem_simulator", data.clone())?;
    write_storage(&storage).map_err(|e| e.to_string())?;
    Ok(Resp::new(true).into())
}

/// `{"Physical Damage": 1, ...}`: `name.replace("_", " ").title()` → value.
fn lookup_table(members: impl Iterator<Item = (&'static str, i64)>) -> Value {
    let title = |name: &str| -> String {
        name.split('_')
            .map(|w| {
                let mut c = w.chars();
                c.next().map(|f| f.to_uppercase().chain(c.flat_map(char::to_lowercase)).collect()).unwrap_or_default()
            })
            .collect::<Vec<String>>()
            .join(" ")
    };
    Value::Object(members.map(|(name, v)| (title(name), json!(v))).collect::<Map<String, Value>>())
}

fn lookups() -> Value {
    json!({
        "types": lookup_table(GemType::ALL.iter().map(|e| (e.member(), e.value()))),
        "elements": lookup_table(GemElement::ALL.iter().map(|e| (e.member(), e.value()))),
        "tiers": lookup_table(GemTier::ALL.iter().map(|e| (e.member(), e.value()))),
        "restrictions": lookup_table(GemRestriction::ALL.iter().map(|e| (e.member(), e.value()))),
        "stat_types": lookup_table(GemStatType::ALL.iter().map(|e| (e.member(), e.value()))),
        "augment_types": lookup_table(AugmentType::ALL.iter().map(|e| (e.member(), e.value()))),
    })
}

fn gem_resp(gem: &Gem) -> Result<Value, String> {
    let payload = gem.dump()?;
    Ok(Resp::ok(json!({"gem": payload})).with("gem", payload).into())
}

fn create_gem(data: &Value) -> Result<Value, String> {
    let gem = if crate::args::truthy(data) {
        let kwargs = data.as_object().ok_or_else(|| super::pyd::not_a_mapping("models.trove.gems.Gem.create", data))?;
        Gem::create(kwargs)?
    } else {
        Gem::create(&Map::new())?
    };
    gem_resp(&gem)
}

fn mass_update_gems(data: &Value) -> Result<Value, String> {
    let mut gems = Vec::new();
    for gem in py::iterate(data)? {
        gems.push(if gem.is_null() { Value::Null } else { Gem::validate(&gem)?.dump()? });
    }
    Ok(Resp::ok(json!({"gems": gems})).with("gems", gems).into())
}

fn level_up_gem(data: &Value) -> Result<Value, String> {
    let mut gem = Gem::validate(data)?;
    if !gem.level_up()? {
        return Ok(Resp::fail("Gem is already at max level.", "GEM_MAX_LEVEL").into());
    }
    gem_resp(&gem)
}

fn not_found() -> Value {
    Resp::fail("Stat type not found in gem", "GEM_STAT_NOT_FOUND").into()
}

fn augment_gem(a: &Args) -> Result<Value, String> {
    let mut gem = Gem::validate(a.get(0))?;
    let kind = lookup(a.get(1), GemStatType::from_value, GemStatType::PY_NAME)?;
    if !gem.has_stat(kind) {
        return Ok(not_found());
    }
    if let Some(stat) = gem.stats.iter_mut().find(|s| s.kind == kind) {
        let augment = lookup(a.get(2), AugmentType::from_value, AugmentType::PY_NAME)?;
        if stat.add_augment(augment)? != Some(true) {
            return Ok(Resp::fail("Stat is already fully augmented", "GEM_STAT_MAX_AUGMENT").into());
        }
        return gem_resp(&gem);
    }
    Ok(Resp::fail("Failed to augment", "GEM_AUGMENT_FAILED").into())
}

fn spark_gem(a: &Args) -> Result<Value, String> {
    let mut gem = Gem::validate(a.get(0))?;
    let kind = lookup(a.get(1), GemStatType::from_value, GemStatType::PY_NAME)?;
    if !gem.has_stat(kind) {
        return Ok(not_found());
    }
    if !gem.reroll_stat_type(kind)? {
        return Ok(Resp::fail("Failed to reroll stat. It might be locked.", "GEM_REROLL_FAILED").into());
    }
    gem_resp(&gem)
}

fn flare_gem(a: &Args) -> Result<Value, String> {
    let mut gem = Gem::validate(a.get(0))?;
    let kind = lookup(a.get(1), GemStatType::from_value, GemStatType::PY_NAME)?;
    if !gem.has_stat(kind) {
        return Ok(not_found());
    }
    if !gem.move_proc(kind)? {
        return Ok(Resp::fail("Cannot move boost from a stat with only one proc.", "GEM_MOVE_PROC_FAILED").into());
    }
    gem_resp(&gem)
}
