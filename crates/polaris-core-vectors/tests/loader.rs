//! The loader accepts the documented format and refuses everything else.

use std::path::Path;

use polaris_core_vectors::{decode, load, parse, Decoded, Expect, LoadError};
use serde_json::json;

fn parse_str(text: &str) -> Result<polaris_core_vectors::VectorFile, LoadError> {
    parse(Path::new("inline.json"), text)
}

fn one_case(args: serde_json::Value, expect: serde_json::Value) -> String {
    json!({
        "domain": "d", "op": "o", "source": "s",
        "cases": [{ "name": "c", "args": args, "expect": expect }]
    })
    .to_string()
}

#[test]
fn decodes_every_tag() {
    let file = parse_str(&one_case(
        json!([
            "plain",
            { "$bytes": "00ff10" },
            { "$utf16": [97, 55296] },
            { "$repeat": { "text": "ab", "times": 3 } },
            [1, true, null],
            { "nested": { "$bytes": "" } }
        ]),
        json!({ "ok": 7 }),
    ))
    .unwrap();
    let args = &file.cases[0].args;
    assert_eq!(args[0], Decoded::Text("plain".into()));
    assert_eq!(args[1], Decoded::Bytes(vec![0, 255, 16]));
    assert_eq!(args[2], Decoded::Utf16(vec![97, 0xd800]));
    assert_eq!(args[2].as_binding_str().unwrap(), "a\u{fffd}");
    assert_eq!(args[3], Decoded::Text("ababab".into()));
    assert_eq!(
        args[4],
        Decoded::Array(vec![
            Decoded::Number(1.into()),
            Decoded::Bool(true),
            Decoded::Null
        ])
    );
    assert_eq!(
        args[5],
        Decoded::Object(vec![("nested".into(), Decoded::Bytes(vec![]))])
    );
    assert_eq!(file.cases[0].expect, Expect::Ok(Decoded::Number(7.into())));
}

#[test]
fn decodes_an_expected_error() {
    let file = parse_str(&one_case(
        json!([]),
        json!({ "error": { "kind": "RangeError", "message": "m" } }),
    ))
    .unwrap();
    assert_eq!(
        file.cases[0].expect,
        Expect::Error {
            kind: "RangeError".into(),
            message: "m".into()
        }
    );
}

#[test]
fn refuses_malformed_tags() {
    for bad in [
        json!({ "$bytes": "abc" }),
        json!({ "$bytes": "AB" }),
        json!({ "$bytes": "zz" }),
        json!({ "$bytes": "é0" }),
        json!({ "$bytes": 12 }),
        json!({ "$utf16": [70000] }),
        json!({ "$utf16": [-1] }),
        json!({ "$repeat": { "text": "a" } }),
        json!({ "$repeat": { "text": "a", "times": 2, "extra": 1 } }),
        json!({ "$repeat": { "text": "aaaa", "times": 1u64 << 40 } }),
        json!({ "$bytes": "00", "other": 1 }),
        json!({ "$unknown": 1 }),
    ] {
        assert!(decode(&bad).is_err(), "accepted {bad}");
        let err = parse_str(&one_case(json!([bad]), json!({ "ok": null }))).unwrap_err();
        assert!(matches!(err, LoadError::Case { .. }), "{err}");
    }
}

#[test]
fn refuses_ambiguous_or_empty_expectations() {
    for bad in [
        json!({}),
        json!({ "ok": 1, "error": { "kind": "E", "message": "m" } }),
        json!({ "error": { "kind": "E" } }),
        json!({ "error": { "kind": "E", "message": 3 } }),
        json!({ "error": { "kind": "E", "message": "m", "x": 1 } }),
        json!({ "value": 1 }),
    ] {
        assert!(
            parse_str(&one_case(json!([]), bad.clone())).is_err(),
            "accepted {bad}"
        );
    }
}

#[test]
fn refuses_a_file_with_no_cases_or_unknown_fields() {
    let empty = json!({ "domain": "d", "op": "o", "source": "s", "cases": [] }).to_string();
    assert!(matches!(parse_str(&empty), Err(LoadError::File { .. })));
    let extra = json!({ "domain": "d", "op": "o", "source": "s", "cases": [], "x": 1 }).to_string();
    assert!(matches!(parse_str(&extra), Err(LoadError::Json { .. })));
    assert!(matches!(parse_str("{"), Err(LoadError::Json { .. })));
}

#[test]
fn refuses_names_that_leave_the_directory() {
    for bad in ["", "..", "../probe", "probe/x", "a b"] {
        assert!(
            matches!(load(bad, "fnv1a32"), Err(LoadError::BadName(_))),
            "{bad:?}"
        );
        assert!(
            matches!(load("probe", bad), Err(LoadError::BadName(_))),
            "{bad:?}"
        );
    }
}

#[test]
fn a_missing_file_is_an_io_error() {
    assert!(matches!(
        load("probe", "doesNotExist"),
        Err(LoadError::Io { .. })
    ));
}

#[test]
fn loads_every_committed_vector_file() {
    let root = polaris_core_vectors::vectors_dir();
    let mut seen = 0;
    for domain in std::fs::read_dir(&root).unwrap() {
        let domain = domain.unwrap();
        if !domain.file_type().unwrap().is_dir()
            || domain.file_name() == "src"
            || domain.file_name() == "tests"
        {
            continue;
        }
        for file in std::fs::read_dir(domain.path()).unwrap() {
            let path = file.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let op = path.file_stem().unwrap().to_str().unwrap().to_string();
            let name = domain.file_name().into_string().unwrap();
            let loaded = load(&name, &op).unwrap_or_else(|e| panic!("{e}"));
            assert!(!loaded.cases.is_empty());
            seen += 1;
        }
    }
    assert!(seen >= 2, "expected the probe vectors, found {seen} files");
}
