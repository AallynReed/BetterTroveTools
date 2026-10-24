//! Mod share codes: an install's enabled mods as a short code a friend pastes to get the
//! same set. A code names only each mod's source and id; names, authors and whether a
//! mod is still offered are looked up from the sources when the code is read, so a code
//! can't pass one mod off as another.

use std::collections::HashSet;
use std::io::{Read, Write};

use anyhow::{anyhow, bail, Result};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde_json::{json, Map, Value};

use super::{blocklist, by_id, get, guard, hub, manager, steam_catalog, trovesaurus};
use crate::game::registry::TroveGamePath;
use crate::game::trove_cfg::read_disabled_mods;
use crate::modfile::ListOptions;
use crate::py::{self, display};
use crate::{Args, Resp};

const PREFIX: &str = "BTT-MODS-1:";
const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Shared {
    Hub { r: String, branch: Option<String> },
    Trovesaurus(String),
    Workshop(String),
}

fn is_slug(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

impl Shared {
    fn line(&self) -> String {
        match self {
            Shared::Hub { r, branch: Some(b) } => format!("h {r}@{b}"),
            Shared::Hub { r, branch: None } => format!("h {r}"),
            Shared::Trovesaurus(id) => format!("t {id}"),
            Shared::Workshop(id) => format!("w {id}"),
        }
    }

    fn parse(line: &str) -> Option<Shared> {
        let (kind, rest) = line.trim().split_once(' ')?;
        let rest = rest.trim();
        match kind {
            "h" => {
                let (r, branch) = match rest.split_once('@') {
                    Some((r, b)) => (r, Some(b)),
                    None => (rest, None),
                };
                let (handle, slug) = r.split_once('/')?;
                if !is_slug(handle) || !is_slug(slug) || branch.is_some_and(|b| !is_slug(b)) {
                    return None;
                }
                Some(Shared::Hub { r: r.to_string(), branch: branch.map(String::from) })
            }
            "t" if py::isdigit(rest) => Some(Shared::Trovesaurus(rest.to_string())),
            "w" if py::isdigit(rest) => Some(Shared::Workshop(rest.to_string())),
            _ => None,
        }
    }

    fn source(&self) -> &'static str {
        match self {
            Shared::Hub { .. } => "hub",
            Shared::Trovesaurus(_) => "trovesaurus",
            Shared::Workshop(_) => "workshop",
        }
    }

    /// What identifies the mod regardless of branch, for "already installed".
    fn key(&self) -> String {
        match self {
            Shared::Hub { r, .. } => format!("h {r}"),
            other => other.line(),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Shared::Hub { r, branch } => json!({ "source": "hub", "id": r, "branch": branch }),
            Shared::Trovesaurus(id) | Shared::Workshop(id) => json!({ "source": self.source(), "id": id, "branch": null }),
        }
    }

    fn from_json(v: &Value) -> Option<Shared> {
        let id = py::str_of(get(v, "id"));
        let line = match py::str_of(get(v, "source")).as_str() {
            "hub" => match get(v, "branch").as_str().filter(|b| !b.is_empty()) {
                Some(b) => format!("h {id}@{b}"),
                None => format!("h {id}"),
            },
            "trovesaurus" => format!("t {id}"),
            "workshop" => format!("w {id}"),
            _ => return None,
        };
        Shared::parse(&line)
    }
}

pub fn encode(entries: &[Shared]) -> Result<String> {
    let text = entries.iter().map(Shared::line).collect::<Vec<_>>().join("\n");
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::best());
    enc.write_all(text.as_bytes())?;
    // Standard base64, not URL-safe: Discord reads `_` as italics and mangles a pasted code.
    Ok(format!("{PREFIX}{}", py::b64encode(&enc.finish()?)))
}

/// Accepts the code inside surrounding text and across line breaks.
pub fn decode(code: &str) -> Result<Vec<Shared>> {
    let compact: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    let start = compact.find(PREFIX).ok_or_else(|| anyhow!("That isn't a mod share code."))?;
    let body: String = compact[start + PREFIX.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || "+/=".contains(*c)).collect();
    let damaged = || anyhow!("This share code is incomplete or damaged. Copy the whole code and try again.");
    let bytes = py::b64decode(&body).map_err(|_| damaged())?;
    let mut text = String::new();
    DeflateDecoder::new(&bytes[..]).take(256 * 1024).read_to_string(&mut text).map_err(|_| damaged())?;
    let mut seen = HashSet::new();
    let entries: Vec<Shared> = text.lines().filter_map(Shared::parse).filter(|e| seen.insert(e.key())).take(MAX_ENTRIES).collect();
    if entries.is_empty() {
        bail!("This share code doesn't list any mods.");
    }
    Ok(entries)
}

/// Every mod of `game` with a known source, as (name, entry), plus the names of the
/// mods without one. `enabled_only` leaves disabled mods out of both.
fn sources_of(game: &Value, enabled_only: bool) -> Result<(Vec<(String, Shared)>, Vec<String>)> {
    let mut list = manager::mod_list(game, ListOptions::default())?;
    let trove_disabled = read_disabled_mods(None);
    let hub_states = if crate::MODS_HUB_ENABLED { hub::get_mods_hub_install_states(game, false) } else { json!({}) };
    let hub_states = get(&hub_states, "states").as_object().cloned().unwrap_or_default();
    let workshop_root = TroveGamePath::new(py::path_arg(game)?, None).workshop_path();

    let mut found = Vec::new();
    let mut missing = Vec::new();
    let mut by_hash: Vec<(String, String)> = Vec::new();
    for m in list.mods.iter_mut() {
        if enabled_only && !manager::is_on(m, &trove_disabled) {
            continue;
        }
        let name = m.name().filter(|n| !n.is_empty()).unwrap_or("Unknown Mod").to_string();
        if let Some(state) = hub_states.get(&display(&m.mod_path)) {
            let r = py::str_of(get(state, "ref"));
            let branch = get(state, "branch").as_str().filter(|b| !b.is_empty()).map(String::from);
            if let Some(entry) = Shared::parse(&Shared::Hub { r, branch }.line()) {
                found.push((name, entry));
                continue;
            }
        }
        if m.is_workshop {
            let id = workshop_root.as_ref().and_then(|root| m.mod_path.strip_prefix(root).ok()).and_then(|rel| rel.components().next()).map(|c| c.as_os_str().to_string_lossy().into_owned());
            match id.filter(|id| py::isdigit(id)) {
                Some(id) => found.push((name, Shared::Workshop(id))),
                None => missing.push(name),
            }
            continue;
        }
        let hash = m.hash()?.to_lowercase();
        if hash.is_empty() {
            missing.push(name);
        } else {
            by_hash.push((hash, name));
        }
    }
    if !by_hash.is_empty() {
        let hashes: Vec<&String> = by_hash.iter().map(|(h, _)| h).collect();
        let Some(resolved) = trovesaurus::resolve_hashes(&hashes, "Fetching Mod Hashes") else {
            bail!("Trovesaurus didn't answer, so its mods can't be added to the code. Check your connection and try again.");
        };
        let resolved: Map<String, Value> = resolved.into_iter().map(|(h, id)| (h.to_lowercase(), id)).collect();
        for (hash, name) in by_hash {
            match resolved.get(&hash).map(py::str_of).filter(|id| py::isdigit(id)) {
                Some(id) => found.push((name, Shared::Trovesaurus(id))),
                None => missing.push(name),
            }
        }
    }
    Ok((found, missing))
}

pub(super) fn create_mod_share_code(a: &Args) -> Result<Value> {
    Ok(guard("SHARE_CODE_FAILED", || {
        let (mut found, missing) = sources_of(a.get(0), true)?;
        found.sort_by(|x, y| x.0.to_lowercase().cmp(&y.0.to_lowercase()));
        let mut seen = HashSet::new();
        found.retain(|(_, e)| seen.insert(e.key()));
        if found.is_empty() {
            return Ok(Resp::fail("None of your enabled mods come from the Mods Hub, Trovesaurus or the Steam Workshop, so there's nothing to share.", "NOTHING_TO_SHARE")
                .data(json!({ "unshareable": missing }))
                .into());
        }
        let entries: Vec<Shared> = found.iter().map(|(_, e)| e.clone()).collect();
        let code = encode(&entries)?;
        let mods: Vec<Value> = found.iter().map(|(name, e)| json!({ "name": name, "source": e.source() })).collect();
        Ok(Resp::ok(json!({ "code": code, "mods": mods, "unshareable": missing })).into())
    }))
}

/// One code entry with what its source says about it now.
fn describe(entry: &Shared, mods_all: &Option<Map<String, Value>>, workshop: &Option<Map<String, Value>>, installed: &HashSet<String>) -> Value {
    let mut out = entry.to_json();
    let (name, author, available) = match entry {
        Shared::Hub { r, .. } => match hub::fetch_mod_detail(r, true).filter(|d| py::truthy(get(d, "title"))) {
            Some(d) => (get(&d, "title").clone(), get(&d, "author").clone(), true),
            None => (Value::Null, Value::Null, false),
        },
        Shared::Trovesaurus(id) => match mods_all.as_ref().and_then(|m| m.get(id)).filter(|d| py::truthy(d)) {
            Some(d) => {
                let author = get(d, "author");
                let author = if author.is_object() { get(author, "Username") } else { author };
                (get(d, "name").clone(), author.clone(), !blocklist::load().blocked(d))
            }
            None => (Value::Null, Value::Null, false),
        },
        Shared::Workshop(id) => match workshop.as_ref().and_then(|m| m.get(id)) {
            Some(d) => (get(d, "title").clone(), get(d, "creator_name").clone(), true),
            None => (Value::Null, Value::Null, false),
        },
    };
    out["name"] = name;
    out["author"] = author;
    out["available"] = json!(available);
    out["installed"] = json!(installed.contains(&entry.key()));
    out
}

pub(super) fn read_mod_share_code(a: &Args) -> Result<Value> {
    Ok(guard("SHARE_CODE_UNREADABLE", || {
        let entries = match decode(&py::str_of(a.get(1))) {
            Ok(e) => e,
            Err(e) => return Ok(Resp::fail(e.to_string(), "INVALID_CODE").into()),
        };
        let installed: HashSet<String> = if py::truthy(a.get(0)) {
            sources_of(a.get(0), false).map(|(found, _)| found.into_iter().map(|(_, e)| e.key()).collect()).unwrap_or_default()
        } else {
            HashSet::new()
        };
        let mods_all = entries.iter().any(|e| matches!(e, Shared::Trovesaurus(_))).then(|| match trovesaurus::mods_all() {
            Ok(Value::Array(items)) => by_id(&items),
            _ => Map::new(),
        });
        let workshop = entries.iter().any(|e| matches!(e, Shared::Workshop(_))).then(|| {
            steam_catalog::catalog_items().into_iter().map(|item| (py::str_of(get(&item, "published_file_id")), item)).collect::<Map<String, Value>>()
        });
        let described: Vec<Value> = entries.iter().map(|e| describe(e, &mods_all, &workshop, &installed)).collect();
        Ok(Resp::ok(json!({ "entries": described })).into())
    }))
}

pub(super) fn install_shared_mod(a: &Args) -> Result<Value> {
    let game = a.get(0);
    let Some(entry) = Shared::from_json(a.get(1)) else {
        return Ok(Resp::fail("Not a mod from a share code.", "INVALID_ENTRY").into());
    };
    Ok(match entry {
        Shared::Hub { r, branch } => hub::install_mods_hub_mod_sync(game, &json!(r), &json!(branch)),
        Shared::Trovesaurus(id) => match trovesaurus::install(game, &json!(id)) {
            Ok(Ok(())) => Resp::ok(json!({ "mod_id": id })).into(),
            Ok(Err(e)) => Resp::fail(e, "INSTALL_FAILED").into(),
            Err(e) => Resp::fail(e.to_string(), "INSTALL_FAILED").into(),
        },
        Shared::Workshop(id) => steam_catalog::subscribe_workshop_item(&Args::new(vec![json!(id)]))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_survives_pasting() {
        let entries = vec![
            Shared::Hub { r: "zakros/zakros-ui-atlas".into(), branch: Some("main".into()) },
            Shared::Hub { r: "someone/thing".into(), branch: None },
            Shared::Trovesaurus("12345".into()),
            Shared::Workshop("2987654321".into()),
        ];
        let code = encode(&entries).unwrap();
        assert!(code.starts_with(PREFIX));
        assert!(!code.contains('_'));
        assert_eq!(decode(&code).unwrap(), entries);
        let (head, tail) = code.split_at(20);
        assert_eq!(decode(&format!("here you go:\n{head}\n{tail}  enjoy")).unwrap(), entries);
    }

    #[test]
    fn rejects_damaged_codes_and_bad_entries() {
        assert!(decode("hello").is_err());
        assert!(decode(&format!("{PREFIX}!!!!")).is_err());
        let code = encode(&[Shared::Trovesaurus("1".into())]).unwrap();
        assert!(decode(&code[..code.len() - 4]).is_err());
        assert_eq!(Shared::parse("h ../../etc"), None);
        assert_eq!(Shared::parse("h a/b@x y"), None);
        assert_eq!(Shared::parse("t 12a"), None);
        assert_eq!(Shared::parse("w 77"), Some(Shared::Workshop("77".into())));
    }

    #[test]
    fn drops_duplicates_across_branches() {
        let code = encode(&[
            Shared::Hub { r: "a/b".into(), branch: Some("main".into()) },
            Shared::Hub { r: "a/b".into(), branch: Some("beta".into()) },
            Shared::Trovesaurus("5".into()),
            Shared::Trovesaurus("5".into()),
        ])
        .unwrap();
        assert_eq!(decode(&code).unwrap().len(), 2);
    }
}
