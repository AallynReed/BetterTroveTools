//! models/trovesaurus/mods.py: a Trovesaurus catalog entry, validated the way pydantic
//! (v2, lax mode) validated it. Any failure rejects the whole entry.

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModFileType {
    Tmod,
    Zip,
    Config,
}

impl ModFileType {
    /// The enum's value: also the file extension of a download.
    pub fn value(self) -> &'static str {
        match self {
            ModFileType::Tmod => "tmod",
            ModFileType::Zip => "zip",
            ModFileType::Config => "config",
        }
    }
}

/// `ModFile`: one downloadable release of a mod.
#[derive(Debug, Clone, PartialEq)]
pub struct TsFile {
    pub file_id: i64,
    pub file_type: ModFileType,
    pub is_config: bool,
    pub version: String,
    pub changes: String,
    pub created_at: DateTime<Utc>,
    pub downloads: i64,
    pub size: i64,
    pub hash: String,
}

impl TsFile {
    /// `created_at.isoformat()`.
    pub fn created_iso(&self) -> String {
        self.created_at.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModAuthor {
    pub id: Option<i64>,
    pub username: Option<String>,
    pub avatar: Option<String>,
    pub role: Option<String>,
}

impl ModAuthor {
    pub fn avatar_url(&self) -> String {
        match self.avatar.as_deref() {
            None | Some("") => String::new(),
            Some(a) if a.starts_with("//") => format!("https:{}", a),
            Some(a) => a.replace("http:", "https:"),
        }
    }
}

/// `Mod`: a catalog entry plus what the Mod Manager learned about the installed copy.
#[derive(Debug, Clone, PartialEq)]
pub struct Mod {
    pub id: i64,
    pub name: String,
    pub mod_type: String,
    pub subtype: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub downloads: i64,
    pub thumbnail_url: String,
    pub notes: String,
    pub likes: i64,
    pub author: ModAuthor,
    pub file_objs: Vec<TsFile>,
    pub installed: bool,
    pub installed_file: Option<TsFile>,
    pub installed_version: Option<String>,
    pub obsolete: i64,
}

impl Mod {
    /// `Mod(**raw)`.
    pub fn from_value(raw: &Value) -> Result<Mod> {
        let Value::Object(m) = raw else { bail!("argument after ** must be a mapping, not {}", crate::py::type_name(raw)) };
        Ok(Mod {
            id: int_field(m, "id")?,
            name: str_field(m, "name")?,
            mod_type: str_field(m, "type")?,
            subtype: str_or(m, "subtype", "")?,
            description: str_or(m, "description", "")?,
            created_at: timestamp_field(m, "date")?,
            downloads: int_or(m, "totaldownloads", 0)?,
            thumbnail_url: str_or(m, "image", "")?,
            notes: str_or(m, "notes", "")?,
            likes: int_or(m, "likes", 0)?,
            author: author_field(m.get("author").ok_or_else(|| anyhow!("author: Field required"))?)?,
            file_objs: match m.get("downloads") {
                None => Vec::new(),
                Some(Value::Array(items)) => items.iter().map(TsFile::from_value).collect::<Result<_>>()?,
                Some(_) => bail!("downloads: Input should be a valid list"),
            },
            installed: bool_or(m, "installed", false)?,
            installed_file: match m.get("installed_file") {
                None | Some(Value::Null) => None,
                Some(v) => Some(TsFile::from_value(v)?),
            },
            installed_version: match m.get("installed_version") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => bail!("installed_version: Input should be a valid string"),
            },
            obsolete: int_or(m, "obsolete", 0)?,
        })
    }

    pub fn hashes(&self) -> Vec<&str> {
        self.file_objs.iter().map(|f| f.hash.as_str()).collect()
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.file_objs.iter().any(|f| f.hash == hash)
    }

    pub fn url(&self) -> String {
        format!("https://trovesaurus.com/mod={}", self.id)
    }

    pub fn is_obsolete(&self) -> bool {
        self.obsolete != 0
    }

    /// The non-config files, newest (highest id) first.
    pub fn releases(&self) -> Vec<&TsFile> {
        let mut files: Vec<&TsFile> = self.file_objs.iter().filter(|f| !f.is_config).collect();
        files.sort_by_key(|f| -f.file_id);
        files
    }
}

impl TsFile {
    pub fn from_value(raw: &Value) -> Result<TsFile> {
        let Value::Object(m) = raw else { bail!("Input should be a valid dictionary") };
        let file_id = int_field(m, "fileid");
        let file_type = match m.get("format") {
            Some(Value::String(s)) if s == "tmod" => Ok(ModFileType::Tmod),
            Some(Value::String(s)) if s == "zip" => Ok(ModFileType::Zip),
            Some(Value::String(s)) if s == "config" => Ok(ModFileType::Config),
            _ => Err(anyhow!("format: Input should be 'tmod', 'zip' or 'config'")),
        };
        let is_config = bool_or(m, "extra", false);
        let version = match m.get("version") {
            Some(Value::String(s)) => {
                if matches!(is_config, Ok(true)) {
                    Ok("config".to_string())
                } else if crate::py::strip(s).is_empty() {
                    Ok(format!("File: [{}]", file_id.as_ref().map(|i| i.to_string()).unwrap_or_else(|_| "None".into())))
                } else {
                    Ok(s.clone())
                }
            }
            _ => Err(anyhow!("version: Input should be a valid string")),
        };
        Ok(TsFile {
            file_id: file_id?,
            file_type: file_type?,
            is_config: is_config?,
            version: version?,
            changes: str_or(m, "changes", "")?,
            created_at: timestamp_field(m, "date")?,
            downloads: int_or(m, "downloads", 0)?,
            size: int_or(m, "size", 0)?,
            hash: str_or(m, "hash", "")?,
        })
    }
}

fn author_field(v: &Value) -> Result<ModAuthor> {
    let Value::Object(m) = v else { bail!("author: Input should be a valid dictionary") };
    let opt_str = |key: &str| -> Result<Option<String>> {
        match m.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => bail!("author.{}: Input should be a valid string", key),
        }
    };
    Ok(ModAuthor {
        id: match m.get("ID") {
            None | Some(Value::Null) => None,
            Some(v) => Some(lax_int(v).ok_or_else(|| anyhow!("author.ID: Input should be a valid integer"))?),
        },
        username: opt_str("Username")?,
        avatar: opt_str("Avatar")?,
        role: opt_str("Role")?,
    })
}

/// pydantic's lax `int`: ints, bools, integral floats and integer strings.
fn lax_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.is_finite()).map(|f| f as i64)),
        Value::String(s) => {
            let as_int = |t: &str| crate::py::int_lenient(&Value::String(t.to_string())).ok();
            let t = crate::py::strip(s);
            if let Some(i) = as_int(t) {
                return Some(i);
            }
            let (int_part, frac) = t.split_once('.')?;
            if int_part.is_empty() || !frac.chars().all(|c| c == '0') {
                return None;
            }
            as_int(int_part)
        }
        _ => None,
    }
}

/// pydantic's lax `bool`.
fn lax_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_f64().filter(|f| *f == 0.0 || *f == 1.0).map(|f| f == 1.0),
        Value::String(s) => match s.to_lowercase().as_str() {
            "0" | "off" | "f" | "false" | "n" | "no" => Some(false),
            "1" | "on" | "t" | "true" | "y" | "yes" => Some(true),
            _ => None,
        },
        _ => None,
    }
}

fn int_field(m: &Map<String, Value>, key: &str) -> Result<i64> {
    let v = m.get(key).ok_or_else(|| anyhow!("{}: Field required", key))?;
    lax_int(v).ok_or_else(|| anyhow!("{}: Input should be a valid integer", key))
}

fn int_or(m: &Map<String, Value>, key: &str, default: i64) -> Result<i64> {
    match m.get(key) {
        None => Ok(default),
        Some(v) => lax_int(v).ok_or_else(|| anyhow!("{}: Input should be a valid integer", key)),
    }
}

fn bool_or(m: &Map<String, Value>, key: &str, default: bool) -> Result<bool> {
    match m.get(key) {
        None => Ok(default),
        Some(v) => lax_bool(v).ok_or_else(|| anyhow!("{}: Input should be a valid boolean", key)),
    }
}

fn str_field(m: &Map<String, Value>, key: &str) -> Result<String> {
    match m.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => bail!("{}: Input should be a valid string", key),
        None => bail!("{}: Field required", key),
    }
}

fn str_or(m: &Map<String, Value>, key: &str, default: &str) -> Result<String> {
    match m.get(key) {
        None => Ok(default.to_string()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => bail!("{}: Input should be a valid string", key),
    }
}

/// The `parse_timestamp` validator: `datetime.fromtimestamp(int(value), timezone.utc)`.
fn timestamp_field(m: &Map<String, Value>, key: &str) -> Result<DateTime<Utc>> {
    let v = m.get(key).ok_or_else(|| anyhow!("{}: Field required", key))?;
    let secs = crate::py::int_lenient(v)?;
    let dt = DateTime::from_timestamp(secs, 0).ok_or_else(|| anyhow!("timestamp out of range"))?;
    use chrono::Datelike;
    if !(1..=9999).contains(&dt.year()) {
        bail!("[Errno 22] Invalid argument");
    }
    Ok(dt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_like_pydantic() {
        let base = json!({"fileid": 5, "format": "tmod", "version": "1.0", "date": 1700000000});
        let file = |patch: Value| {
            let mut v = base.clone();
            for (k, val) in patch.as_object().unwrap() {
                v[k] = val.clone();
            }
            TsFile::from_value(&v)
        };
        assert_eq!(file(json!({})).unwrap().created_iso(), "2023-11-14T22:13:20+00:00");
        assert_eq!(file(json!({"extra": "1"})).unwrap().version, "config");
        assert_eq!(file(json!({"version": "  "})).unwrap().version, "File: [5]");
        assert_eq!(file(json!({"fileid": "7", "version": " "})).unwrap().version, "File: [7]");
        assert_eq!(file(json!({"date": 1.9})).unwrap().created_iso(), "1970-01-01T00:00:01+00:00");
        assert_eq!(file(json!({"date": -5})).unwrap().created_iso(), "1969-12-31T23:59:55+00:00");
        for bad in [json!({"date": "1.5"}), json!({"date": null}), json!({"format": "TMOD"}), json!({"hash": null}), json!({"date": 253402300800i64})] {
            assert!(file(bad.clone()).is_err(), "{bad}");
        }
        assert_eq!(lax_int(&json!(" 12 ")), Some(12));
        assert_eq!(lax_int(&json!("1.0")), Some(1));
        assert_eq!(lax_int(&json!("1_000")), Some(1000));
        assert_eq!(lax_int(&json!("1e3")), None);
        assert_eq!(lax_int(&json!(1.5)), None);
        assert_eq!(lax_bool(&json!("YES")), Some(true));
        assert_eq!(lax_bool(&json!(" true ")), None);
        assert_eq!(lax_bool(&json!(2)), None);
    }
}
