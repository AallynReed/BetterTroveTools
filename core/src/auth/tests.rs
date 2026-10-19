use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::*;

/// Test-only redirects for the API roots, the file picker and the system browser.
pub(super) static BASES: Mutex<Option<(String, String)>> = Mutex::new(None);
pub(super) static PICK: Mutex<Option<PathBuf>> = Mutex::new(None);
pub(super) static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[test]
fn requotes_like_requests() {
    assert_eq!(requote_uri("https://h/v1/mods/hub/projects/a b/c|d^é"), "https://h/v1/mods/hub/projects/a%20b/c%7Cd%5E%C3%A9");
    assert_eq!(requote_uri("https://h/x%41%2F?q=a%20b"), "https://h/xA%2F?q=a%20b");
    assert_eq!(requote_uri("https://h/100%zz"), "https://h/100%25zz");
}

#[test]
fn int_like_python() {
    assert_eq!(crate::py::int_loose_underscores(&json!(20)).unwrap(), 20);
    assert_eq!(crate::py::int_loose_underscores(&json!(20.9)).unwrap(), 20);
    assert_eq!(crate::py::int_loose_underscores(&json!(" 1_5 ")).unwrap(), 15);
    assert_eq!(crate::py::int_loose_underscores(&json!("2.5")).unwrap_err().to_string(), "invalid literal for int() with base 10: '2.5'");
    assert_eq!(
        crate::py::int_loose_underscores(&Value::Null).unwrap_err().to_string(),
        "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'"
    );
}

#[test]
fn json_errors_like_python() {
    assert_eq!(crate::py::loads_bytes(b"").unwrap_err().to_string(), "Expecting value: line 1 column 1 (char 0)");
    assert_eq!(crate::py::loads_bytes(b"\n  <html>").unwrap_err().to_string(), "Expecting value: line 2 column 3 (char 3)");
    assert_eq!(crate::py::loads_bytes(b"\xef\xbb\xbf{\"a\": 1}").unwrap(), json!({"a": 1}));
}

#[test]
fn multipart_layout() {
    let file = Upload { name: "a\"b.tmod".into(), bytes: b"DATA".to_vec(), mime: "application/octet-stream".into() };
    let (content_type, body) = multipart(&[("tag", "v1".into())], &file);
    let boundary = content_type.strip_prefix("multipart/form-data; boundary=").unwrap();
    assert_eq!(boundary.len(), 32);
    let expected = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"tag\"\r\n\r\nv1\r\n--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a%22b.tmod\"\r\nContent-Type: application/octet-stream\r\n\r\nDATA\r\n--{b}--\r\n",
        b = boundary
    );
    assert_eq!(String::from_utf8(body).unwrap(), expected);
}

#[cfg(windows)]
#[test]
fn dpapi_round_trip() {
    let blob = secure_store::dpapi::protect(b"{\"access_token\": \"a\"}").unwrap();
    assert_eq!(secure_store::dpapi::unprotect(&blob).unwrap(), b"{\"access_token\": \"a\"}");
    assert!(secure_store::dpapi::unprotect(b"garbage").is_none());
}

/// Runs a scripted list of steps for tools/parity/auth.py and writes what happened.
/// Needs BTT_PARITY_SCRIPT, BTT_PARITY_OUT and BTT_PARITY_APPDATA (a throwaway folder).
#[test]
#[ignore]
fn parity_harness() {
    let (Ok(script), Ok(out), Ok(appdata)) = (std::env::var("BTT_PARITY_SCRIPT"), std::env::var("BTT_PARITY_OUT"), std::env::var("BTT_PARITY_APPDATA")) else {
        return;
    };
    std::env::set_var("APPDATA", &appdata);
    let host = crate::ctx::testing::init();
    let steps: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(script).unwrap()).unwrap();
    let mut results = Vec::new();
    for step in steps {
        let seen = host.calls.lock().len();
        OPENED.lock().clear();
        let result = match step["op"].as_str().unwrap() {
            "call" => {
                let args = step["args"].as_array().cloned().unwrap_or_default();
                match crate::call(step["name"].as_str().unwrap(), args) {
                    Some(Ok(v)) => v,
                    Some(Err(e)) => json!({ "raised": e }),
                    None => json!({ "missing": true }),
                }
            }
            "restart" => {
                let mut state = STATE.lock();
                state.tokens = None;
                state.user = None;
                state.loaded = false;
                Value::Null
            }
            "bases" => {
                *BASES.lock() = Some((step["api"].as_str().unwrap().into(), step["site"].as_str().unwrap().into()));
                Value::Null
            }
            "pick" => {
                *PICK.lock() = step["path"].as_str().map(PathBuf::from);
                Value::Null
            }
            "store_save" => json!(secure_store::save_tokens(step["tokens"].as_object().unwrap()).unwrap()),
            "store_load" => json!(secure_store::load_tokens()),
            "purge" => {
                purge_legacy_launcher_secrets();
                Value::Null
            }
            "write_file" => {
                use base64::Engine;
                let target = PathBuf::from(&appdata).join(step["path"].as_str().unwrap());
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(target, base64::engine::general_purpose::STANDARD.decode(step["b64"].as_str().unwrap()).unwrap()).unwrap();
                Value::Null
            }
            "exists" => json!(PathBuf::from(&appdata).join(step["path"].as_str().unwrap()).exists()),
            other => panic!("unknown op {other}"),
        };
        let js: Vec<Value> = host.calls.lock()[seen..].iter().map(|(name, args)| json!([name, args])).collect();
        results.push(json!({ "result": result, "js": js, "opened": OPENED.lock().clone() }));
    }
    std::fs::write(out, serde_json::to_string_pretty(&results).unwrap()).unwrap();
}
