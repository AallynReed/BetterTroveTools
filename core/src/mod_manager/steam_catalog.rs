//! steam_catalog.py: the Steam tab, Trove's Steam Workshop as mirrored by the Kiwi API
//! (blocklist already applied). Subscribing goes through Steam itself.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::{ext, finish, get, now, or_str};
use crate::game::registry::TroveGamePath;
use crate::http;
use crate::modder_tools::steam_workshop::{self, SteamError};
use crate::modfile::compat;
use crate::{Args, Resp};

const FRESH_SECONDS: f64 = 600.0;

static CACHE: Mutex<(f64, Option<Value>)> = Mutex::new((0.0, None));

fn catalog_url() -> String {
    format!("{}/btt/workshop", crate::KIWI_API_BASE)
}

fn fetch() -> Option<Value> {
    let url = catalog_url();
    let req = ext("Fetching Steam Workshop", &url);
    match http::send(http::get(&url).set("Accept", "application/json").timeout(Duration::from_secs(20))) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if ok {
                match http::read_json(resp) {
                    Ok(data) if get(&data, "items").is_array() => return Some(data),
                    Ok(_) => {}
                    Err(e) => eprintln!("Failed to fetch the Steam Workshop list: {}", e),
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Failed to fetch the Steam Workshop list: {}", e);
        }
    }
    None
}

fn installed(game: &Value) -> Result<HashSet<String>> {
    if !compat::truthy(game) {
        return Ok(HashSet::new());
    }
    let Some(workshop) = TroveGamePath::new(compat::path_arg(game)?, None).workshop_path() else { return Ok(HashSet::new()) };
    let Ok(rd) = std::fs::read_dir(&workshop) else { return Ok(HashSet::new()) };
    Ok(rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
}

/// The Workshop list with each item marked `installed` when its folder is in this
/// install's Workshop folder. A failed fetch serves the last good list.
pub(super) fn get_steam_workshop_catalog(a: &Args) -> Result<Value> {
    let stale = {
        let c = CACHE.lock();
        compat::truthy(a.get(1)) || c.1.is_none() || now() - c.0 > FRESH_SECONDS
    };
    if stale {
        if let Some(data) = fetch() {
            *CACHE.lock() = (now(), Some(data));
        }
    }
    let Some(data) = CACHE.lock().1.clone() else {
        return Ok(Resp::fail("The Steam Workshop list could not be loaded.", "CATALOG_UNAVAILABLE").into());
    };
    let installed = installed(a.get(0))?;
    let mut items = Vec::new();
    for item in super::items(get(&data, "items")) {
        let Value::Object(mut m) = item.clone() else {
            return Err(anyhow!("cannot convert dictionary update sequence element #0 to a sequence"));
        };
        let id = compat::py_str(m.get("published_file_id").unwrap_or(&Value::Null));
        m.insert("installed".into(), json!(installed.contains(&id)));
        items.push(Value::Object(m));
    }
    Ok(Resp::ok(json!({ "items": items, "fetched_at": get(&data, "fetched_at") })).into())
}

pub(super) fn subscribe_workshop_item(a: &Args) -> Result<Value> {
    let item_id = compat::strip(&or_str(a.get(0))).to_string();
    if !super::isdigit(&item_id) {
        return Ok(Resp::fail("Not a Steam Workshop item id.", "INVALID_ID").into());
    }
    Ok(match steam_workshop::subscribe_item(&item_id) {
        Ok(true) => Resp::ok(json!({ "item_id": item_id })).into(),
        Ok(false) => Resp::fail("Steam did not subscribe this account to the item.", "SUBSCRIBE_REFUSED").into(),
        Err(e) if e.is::<SteamError>() => Resp::fail(e.to_string(), "STEAM_UNAVAILABLE").into(),
        Err(e) => Resp::fail(e.to_string(), "SUBSCRIBE_FAILED").into(),
    })
}
