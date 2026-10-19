//! backend/response.py: the `{success, code, data, error, meta}` envelope.

use serde_json::{Map, Value};

/// Builder for `resp(success, data=..., error=..., code=..., meta=..., **legacy)`.
#[derive(Debug, Clone)]
pub struct Resp {
    success: bool,
    code: Option<String>,
    data: Value,
    error: Value,
    meta: Value,
    legacy: Map<String, Value>,
}

impl Resp {
    pub fn new(success: bool) -> Self {
        Resp { success, code: None, data: Value::Null, error: Value::Null, meta: Value::Null, legacy: Map::new() }
    }

    /// `resp(True, data=data)`.
    pub fn ok(data: impl Into<Value>) -> Self {
        Resp::new(true).data(data)
    }

    /// `resp(False, error=error, code=code)`.
    pub fn fail(error: impl Into<String>, code: &str) -> Self {
        Resp::new(false).error(error).code(code)
    }

    pub fn data(mut self, data: impl Into<Value>) -> Self {
        self.data = data.into();
        self
    }

    pub fn error(mut self, error: impl Into<String>) -> Self {
        self.error = Value::String(error.into());
        self
    }

    pub fn code(mut self, code: &str) -> Self {
        self.code = Some(code.to_string());
        self
    }

    pub fn meta(mut self, meta: impl Into<Value>) -> Self {
        self.meta = meta.into();
        self
    }

    /// One `**legacy` keyword.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.legacy.insert(key.to_string(), value.into());
        self
    }

    /// `**data`: copies every key of the (object) data payload to the top level.
    pub fn spread(mut self) -> Self {
        if let Value::Object(map) = &self.data {
            for (k, v) in map {
                self.legacy.insert(k.clone(), v.clone());
            }
        }
        self
    }

    /// `**extra` for an arbitrary object.
    pub fn extend(mut self, extra: &Value) -> Self {
        if let Value::Object(map) = extra {
            for (k, v) in map {
                self.legacy.insert(k.clone(), v.clone());
            }
        }
        self
    }

    pub fn into_value(self) -> Value {
        let mut payload = Map::new();
        payload.insert("success".into(), Value::Bool(self.success));
        let code = self.code.unwrap_or_else(|| if self.success { "OK".into() } else { "ERROR".into() });
        payload.insert("code".into(), Value::String(code));
        payload.insert("data".into(), if self.data.is_null() { Value::Object(Map::new()) } else { self.data });
        payload.insert("error".into(), self.error);
        payload.insert("meta".into(), if is_falsy(&self.meta) { Value::Object(Map::new()) } else { self.meta });
        for (k, v) in self.legacy {
            payload.insert(k, v);
        }
        Value::Object(payload)
    }
}

impl From<Resp> for Value {
    fn from(r: Resp) -> Value {
        r.into_value()
    }
}

fn is_falsy(v: &Value) -> bool {
    !crate::args::truthy(v)
}

const ENVELOPE: [&str; 5] = ["success", "code", "data", "error", "meta"];

/// `normalize_response`.
pub fn normalize(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            if ENVELOPE.iter().all(|k| map.contains_key(*k)) {
                return Value::Object(map);
            }
            let success = map.get("success").map(crate::args::truthy).unwrap_or(true);
            let mut r = Resp::new(success);
            if let Some(err) = map.get("error") {
                r.error = err.clone();
            }
            if let Some(Value::String(code)) = map.get("code") {
                if !code.is_empty() {
                    r.code = Some(code.clone());
                }
            }
            if let Some(meta) = map.get("meta") {
                r.meta = meta.clone();
            }
            r.data = if let Some(data) = map.get("data") {
                data.clone()
            } else {
                let mut d = Map::new();
                for (k, v) in &map {
                    if !matches!(k.as_str(), "success" | "error" | "code" | "meta") {
                        d.insert(k.clone(), v.clone());
                    }
                }
                Value::Object(d)
            };
            // `data` explicitly null stays null-as-{} like Python's `data if data is not None else {}`.
            for (k, v) in map {
                if !ENVELOPE.contains(&k.as_str()) {
                    r.legacy.insert(k, v);
                }
            }
            r.into_value()
        }
        Value::Null => Resp::new(true).into_value(),
        other => Resp::new(true).data(serde_json::json!({ "value": other.clone() })).with("value", other).into_value(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_shape_and_order() {
        let v = Resp::ok(json!({"a": 1})).spread().into_value();
        assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"success":true,"code":"OK","data":{"a":1},"error":null,"meta":{},"a":1}"#);
    }

    #[test]
    fn normalize_bare_dict() {
        let v = normalize(json!({"success": false, "error": "x", "foo": 2}));
        assert_eq!(v, json!({"success": false, "code": "ERROR", "data": {"foo": 2}, "error": "x", "meta": {}, "foo": 2}));
    }

    #[test]
    fn normalize_scalar() {
        assert_eq!(normalize(json!(5)), json!({"success": true, "code": "OK", "data": {"value": 5}, "error": null, "meta": {}, "value": 5}));
    }
}
