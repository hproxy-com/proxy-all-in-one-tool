//! Rows as a program reads them: the engine's row with the empty fields left
//! out, or only the fields asked for.
//!
//! The engine's row has twenty-eight keys, most of them empty on any given
//! proxy. A script ignores them for free; an AI assistant pays for every one of
//! them in tokens, and a list of a thousand rows is a thousand copies of the
//! same nulls. So a key with nothing in it is not written. A reader treats a
//! missing key exactly as it would treat `null`.
//!
//! Keys come out in the engine's order (`input` first), or in the order
//! `--fields` named them. The object is written by hand for that: a JSON map
//! here would sort its keys, and a row that starts with `alive` and ends with
//! `timings` is harder for a person to read than one that starts with `input`.

use hproxy_probe::CheckResult;
use serde_json::Value;

/// Every key a row can carry, in the order the engine writes them.
pub const FIELDS: &[&str] = &[
    "input",
    "status",
    "ip",
    "port",
    "alive",
    "protocols",
    "anonymity",
    "latency_ms",
    "supports_udp",
    "speed_mbps",
    "country_code",
    "country",
    "region",
    "city",
    "asn",
    "asn_org",
    "is_datacenter",
    "error",
    "failure",
    "failures",
    "exit_ip",
    "rotating",
    "timings",
    "server",
    "leaked_headers",
    "tls_intercepted",
    "keep_alive",
    "judge",
    "source",
];

/// Read `--fields a,b,c`, refusing a name that no row carries so a typo is
/// caught at once instead of silently printing nothing.
pub fn parse_fields(list: &str) -> Result<Vec<String>, String> {
    let fields: Vec<String> = list
        .split(',')
        .map(|f| f.trim().to_ascii_lowercase())
        .filter(|f| !f.is_empty())
        .collect();
    if fields.is_empty() {
        return Err("--fields needs at least one name, e.g. input,alive,latency_ms".into());
    }
    if let Some(bad) = fields.iter().find(|f| !FIELDS.contains(&f.as_str())) {
        return Err(format!("`{bad}` is not a field. The fields are: {}", FIELDS.join(", ")));
    }
    Ok(fields)
}

/// A key with nothing in it: null, an empty list, an empty text, an empty map.
fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Array(a) => a.is_empty(),
        Value::String(s) => s.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// The row as one line of JSON: every key that has something in it, or with
/// `fields` exactly those keys that do, in order.
pub fn compact(row: &CheckResult, fields: Option<&[String]>) -> String {
    let Ok(Value::Object(all)) = serde_json::to_value(row) else {
        return "{}".into();
    };
    let order: Vec<&str> = match fields {
        Some(wanted) => wanted.iter().map(String::as_str).collect(),
        None => FIELDS.to_vec(),
    };
    let mut out = String::with_capacity(256);
    out.push('{');
    for key in order {
        let Some(v) = all.get(key) else { continue };
        if is_empty(v) {
            continue;
        }
        if out.len() > 1 {
            out.push(',');
        }
        // Keys are the fixed names above: plain ASCII, nothing to escape.
        out.push('"');
        out.push_str(key);
        out.push_str("\":");
        out.push_str(&v.to_string());
    }
    out.push('}');
    out
}

/// A JSON object written in the order its keys are added, for answers a model
/// or a person reads top to bottom.
pub struct Obj(String);

impl Default for Obj {
    fn default() -> Self {
        Self::new()
    }
}

impl Obj {
    pub fn new() -> Self {
        Obj(String::from("{"))
    }

    fn key(&mut self, key: &str) {
        if self.0.len() > 1 {
            self.0.push(',');
        }
        self.0.push_str(&Value::String(key.to_string()).to_string());
        self.0.push(':');
    }

    /// Add a value. Empty values (null, empty list or text) are left out,
    /// like everywhere else in this program's output.
    pub fn put(mut self, key: &str, value: impl serde::Serialize) -> Self {
        let v = serde_json::to_value(value).unwrap_or(Value::Null);
        if !is_empty(&v) {
            self.key(key);
            self.0.push_str(&v.to_string());
        }
        self
    }

    /// Add JSON that is already written (a list of compact rows, an object).
    pub fn raw(mut self, key: &str, json: &str) -> Self {
        self.key(key);
        self.0.push_str(json);
        self
    }

    pub fn done(mut self) -> String {
        self.0.push('}');
        self.0
    }
}

/// `[a,b,c]` from already-written JSON values.
pub fn array(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_probe::Status;

    #[test]
    fn an_object_keeps_the_order_it_was_built_in() {
        let o = Obj::new()
            .put("checked", 3)
            .put("empty", Value::Null)
            .put("list", Vec::<u8>::new())
            .raw("rows", &array(&["{\"a\":1}".into()]))
            .put("seconds", 1.5)
            .done();
        assert_eq!(o, r#"{"checked":3,"rows":[{"a":1}],"seconds":1.5}"#);
        let _: Value = serde_json::from_str(&o).unwrap();
    }

    fn alive_row() -> CheckResult {
        CheckResult {
            input: "203.0.113.9:8080".into(),
            status: Status::Alive,
            ip: Some("203.0.113.9".into()),
            port: Some(8080),
            alive: true,
            protocols: vec!["http".into()],
            latency_ms: Some(65),
            exit_ip: Some("203.0.113.9".into()),
            rotating: Some(false),
            ..Default::default()
        }
    }

    #[test]
    fn empty_fields_are_left_out_and_falsy_facts_are_kept() {
        let text = compact(&alive_row(), None);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert!(!text.contains("null"), "{text}");
        assert!(!text.contains("[]"), "{text}");
        assert_eq!(v["rotating"], Value::Bool(false), "false is a fact, not an empty field");
        assert_eq!(v["latency_ms"], 65);
        assert!(text.starts_with("{\"input\":"), "the input leads: {text}");
        let full = serde_json::to_string(&alive_row()).unwrap();
        assert!(
            text.len() * 2 < full.len(),
            "compact {} vs full {}",
            text.len(),
            full.len()
        );

        let dead = CheckResult {
            input: "x".into(),
            ..Default::default()
        };
        let v: Value = serde_json::from_str(&compact(&dead, None)).unwrap();
        assert_eq!(v["alive"], Value::Bool(false), "a dead row still says so");
    }

    #[test]
    fn fields_pick_exactly_those_keys_in_that_order() {
        let fields = parse_fields("latency_ms, input,alive,country_code").unwrap();
        let text = compact(&alive_row(), Some(&fields));
        // country_code is empty on this row, so it is left out.
        assert_eq!(text, r#"{"latency_ms":65,"input":"203.0.113.9:8080","alive":true}"#);
    }

    #[test]
    fn a_misspelled_field_is_refused_with_the_list() {
        let e = parse_fields("input,latency").unwrap_err();
        assert!(e.contains("`latency`") && e.contains("latency_ms"), "{e}");
        assert!(parse_fields(" , ").is_err());
    }

    #[test]
    fn the_field_list_matches_the_engine_row() {
        let v = serde_json::to_value(CheckResult::default()).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in &keys {
            assert!(FIELDS.contains(k), "the engine row gained `{k}`; add it to FIELDS");
        }
        assert_eq!(keys.len(), FIELDS.len(), "FIELDS names a key the row no longer has");
    }

    #[test]
    fn text_values_are_escaped() {
        let row = CheckResult {
            input: "a\"b\\c".into(),
            ..Default::default()
        };
        let v: Value = serde_json::from_str(&compact(&row, None)).unwrap();
        assert_eq!(v["input"], "a\"b\\c");
    }
}
