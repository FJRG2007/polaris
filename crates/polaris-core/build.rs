//! Turns libphonenumber-js's `/min` metadata (a verbatim copy in
//! `src/phone/metadata.min.json`) into static Rust tables, so the phone domain
//! reads the very same data the TypeScript implementation does, with no JSON
//! parser in the shipped binary. The conversion keeps JavaScript's truthiness:
//! a field the metadata leaves out, writes as `0` or as an empty string is
//! `None` wherever libphonenumber-js tests it with `||` or `if`.

use serde_json::Value;
use std::fmt::Write as _;

fn truthy_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) if !s.is_empty() => format!("Some({s:?})"),
        _ => "None".into(),
    }
}

fn any_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => format!("Some({s:?})"),
        _ => "None".into(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) | Some(Value::Bool(true)) => true,
        _ => false,
    }
}

fn lengths(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => {
            let list: Vec<String> = items
                .iter()
                .map(|n| n.as_u64().expect("a possible length").to_string())
                .collect();
            format!("Some(&[{}])", list.join(", "))
        }
        _ => "None".into(),
    }
}

fn str_list(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(items)) => {
            let list: Vec<String> = items
                .iter()
                .map(|s| format!("{:?}", s.as_str().expect("a pattern")))
                .collect();
            format!("&[{}]", list.join(", "))
        }
        _ => "&[]".into(),
    }
}

fn format_entry(f: &[Value]) -> String {
    let g = |i: usize| f.get(i);
    format!(
        "Format {{ pattern: {:?}, format: {:?}, leading: {}, np_rule: {}, np_optional: {}, intl: {} }}",
        g(0).and_then(Value::as_str).expect("format pattern"),
        g(1).and_then(Value::as_str).expect("format string"),
        str_list(g(2)),
        truthy_str(g(3)),
        truthy(g(4)),
        truthy_str(g(5)),
    )
}

fn plan(raw: &Value) -> String {
    let v = raw.as_array().expect("a numbering plan");
    let at = |i: usize| v.get(i);
    let formats = match at(4) {
        Some(Value::Array(list)) => {
            let items: Vec<String> = list
                .iter()
                .map(|f| format_entry(f.as_array().expect("a format")))
                .collect();
            format!("Some(&[{}])", items.join(", "))
        }
        _ => "None".into(),
    };
    let types = match at(11) {
        Some(Value::Array(list)) => {
            let items: Vec<String> = list
                .iter()
                .map(|t| match t {
                    Value::Array(t) => format!(
                        "Some(TypeDef {{ pattern: {}, lengths: {} }})",
                        any_str(t.first()),
                        lengths(t.get(1))
                    ),
                    _ => "None".into(),
                })
                .collect();
            format!("Some(&[{}])", items.join(", "))
        }
        _ => "None".into(),
    };
    format!(
        "Plan {{ calling_code: {:?}, idd: {}, national_pattern: {}, possible_lengths: {}, formats: {}, national_prefix: {}, np_rule: {}, np_for_parsing: {}, transform_rule: {}, np_optional: {}, leading_digits: {}, types: {}, ext: {} }}",
        at(0).and_then(Value::as_str).expect("calling code"),
        truthy_str(at(1)),
        truthy_str(at(2)),
        lengths(at(3)),
        formats,
        truthy_str(at(5)),
        truthy_str(at(6)),
        truthy_str(at(7)),
        truthy_str(at(8)),
        truthy(at(9)),
        truthy_str(at(10)),
        types,
        truthy_str(at(13)),
    )
}

fn pairs(name: &str, list: &[(String, usize)], out: &mut String) {
    writeln!(out, "pub(super) static {name}: &[(&str, u16)] = &[").unwrap();
    for (k, i) in list {
        writeln!(out, "    ({k:?}, {i}),").unwrap();
    }
    writeln!(out, "];").unwrap();
}

fn main() {
    let source = "src/phone/metadata.min.json";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-changed=build.rs");
    let text = std::fs::read_to_string(source).expect("read the phone metadata");
    let json: Value = serde_json::from_str(&text).expect("parse the phone metadata");
    assert_eq!(
        json["version"], 4,
        "the phone tables expect metadata version 4"
    );

    let mut plans = Vec::new();
    let mut countries = Vec::new();
    for (key, value) in json["countries"].as_object().expect("countries") {
        countries.push((key.clone(), plans.len()));
        plans.push(plan(value));
    }
    let mut non_geo = Vec::new();
    for (key, value) in json["nonGeographic"].as_object().expect("nonGeographic") {
        non_geo.push((key.clone(), plans.len()));
        plans.push(plan(value));
    }
    let mut codes: Vec<(String, Vec<String>)> = json["country_calling_codes"]
        .as_object()
        .expect("country_calling_codes")
        .iter()
        .map(|(k, v)| {
            let list = v
                .as_array()
                .expect("a list of countries")
                .iter()
                .map(|c| c.as_str().expect("a country").to_string())
                .collect();
            (k.clone(), list)
        })
        .collect();
    codes.sort();

    let mut out = String::new();
    writeln!(out, "pub(super) static PLANS: &[Plan] = &[").unwrap();
    for p in &plans {
        writeln!(out, "    {p},").unwrap();
    }
    writeln!(out, "];").unwrap();
    // `COUNTRY_ORDER` keeps the metadata's own order: `getCountries()` lists
    // `Object.keys(countries)`, which for these non-numeric keys is that order.
    pairs("COUNTRY_ORDER", &countries, &mut out);
    let mut sorted = countries.clone();
    sorted.sort();
    pairs("COUNTRY_SORTED", &sorted, &mut out);
    non_geo.sort();
    pairs("NON_GEO_SORTED", &non_geo, &mut out);
    writeln!(
        out,
        "pub(super) static CALLING_CODES_SORTED: &[(&str, &[&str])] = &["
    )
    .unwrap();
    for (k, list) in &codes {
        let items: Vec<String> = list.iter().map(|c| format!("{c:?}")).collect();
        writeln!(out, "    ({k:?}, &[{}]),", items.join(", ")).unwrap();
    }
    writeln!(out, "];").unwrap();

    let dest =
        std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("phone_metadata.rs");
    std::fs::write(dest, out).expect("write the phone tables");
}
