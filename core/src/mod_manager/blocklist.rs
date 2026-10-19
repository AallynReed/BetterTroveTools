//! blocklist.py: Trovesaurus mods and Steam Workshop items the Kiwi API says to hide.
//! No answer within 2 seconds means nothing is hidden.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};

use super::{ext, finish, get, or_str};
use crate::http;
use crate::modfile::compat;

const STEAM_DETAILS_URL: &str = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

fn blocklist_url() -> String {
    format!("{}/btt/mod-blocklist", crate::KIWI_API_BASE)
}

fn fetch() -> Value {
    let url = blocklist_url();
    let req = ext("Fetching Mod Blocklist", &url);
    match http::send(http::get(&url).set("Accept", "application/json").timeout(Duration::from_secs(2))) {
        Ok(resp) => {
            let ok = resp.status() == 200;
            finish(req, ok);
            if ok {
                match http::read_json(resp) {
                    Ok(data) => return data,
                    Err(e) => eprintln!("Failed to fetch the mod blocklist: {}", e),
                }
            }
        }
        Err(e) => {
            finish(req, false);
            eprintln!("Failed to fetch the mod blocklist: {}", e);
        }
    }
    json!({})
}

/// `{str(x) for x in data.get(key) or ()}`.
fn str_set(data: &Value, key: &str) -> HashSet<String> {
    let v = get(data, key);
    if !compat::truthy(v) {
        return HashSet::new();
    }
    compat::iterate(v).unwrap_or_default().iter().map(compat::py_str).collect()
}

fn as_dict(data: Value) -> Value {
    if data.is_object() {
        data
    } else {
        json!({})
    }
}

/// `workshop()`: (item ids, author SteamID64s) to unsubscribe from and delete.
pub(super) fn workshop() -> (HashSet<String>, HashSet<String>) {
    let data = as_dict(fetch());
    (str_set(&data, "workshop_items"), str_set(&data, "workshop_authors"))
}

/// `{item id: creator SteamID64}` from Steam's public item details. Empty when Steam
/// does not answer.
pub(super) fn workshop_creators(item_ids: &[String]) -> HashMap<String, String> {
    if item_ids.is_empty() {
        return HashMap::new();
    }
    let mut form: Vec<(String, String)> = vec![("itemcount".into(), item_ids.len().to_string())];
    for (n, id) in item_ids.iter().enumerate() {
        form.push((format!("publishedfileids[{}]", n), id.clone()));
    }
    let pairs: Vec<(&str, &str)> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let details = http::send_form(http::post(STEAM_DETAILS_URL).timeout(Duration::from_secs(10)), &pairs)
        .and_then(http::read_json)
        .and_then(|v| v.get("response").and_then(|r| r.get("publishedfiledetails")).cloned().ok_or_else(|| anyhow::anyhow!("'response'")));
    let details = match details {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed to look up Workshop creators: {}", e);
            return HashMap::new();
        }
    };
    let mut out = HashMap::new();
    for d in compat::iterate(&details).unwrap_or_default() {
        if d.is_object() && compat::truthy(get(&d, "creator")) {
            out.insert(compat::py_str(get(&d, "publishedfileid")), compat::py_str(get(&d, "creator")));
        }
    }
    out
}

/// `load()`: decides which raw `/api/mods-all` entries are hidden.
pub(super) struct Blocklist {
    authors: HashSet<String>,
    mods: HashSet<String>,
    hashes: HashSet<String>,
}

pub(super) fn load() -> Blocklist {
    Blocklist::from_data(&as_dict(fetch()))
}

impl Blocklist {
    pub(super) fn from_data(data: &Value) -> Blocklist {
        Blocklist {
            authors: str_set(data, "authors"),
            mods: str_set(data, "mods"),
            hashes: str_set(data, "hashes").into_iter().map(|h| h.to_lowercase()).collect(),
        }
    }

    pub(super) fn blocked(&self, m: &Value) -> bool {
        let mod_id = or_str(get(m, "id"));
        let author = get(m, "author");
        let author_id = if author.is_object() { or_str(get(author, "ID")) } else { String::new() };
        if !mod_id.is_empty() && self.mods.contains(&mod_id) {
            return true;
        }
        if !author_id.is_empty() && self.authors.contains(&author_id) {
            return true;
        }
        let downloads = get(m, "downloads");
        if !compat::truthy(downloads) {
            return false;
        }
        compat::iterate(downloads)
            .unwrap_or_default()
            .iter()
            .filter(|f| f.is_object())
            .map(|f| or_str(get(f, "hash")).to_lowercase())
            .any(|h| !h.is_empty() && self.hashes.contains(&h))
    }
}
