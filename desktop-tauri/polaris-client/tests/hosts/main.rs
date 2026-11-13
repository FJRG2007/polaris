//! Ported from `dashboard/packages/core/test/host-list.test.ts` and the
//! list-taking half of `desktop/test/main/host-transfer.test.ts`.

use polaris_client::host_list::{
    encode_host_list, encode_qr, host_list_file, host_list_link, merge_host_lists, qr_svg_path,
    read_host_list, PortableHost, HOST_LIST_MAX,
};
use serde_json::json;

fn hosts() -> Vec<PortableHost> {
    vec![
        PortableHost::new("https://polaris.example.com", Some("Home")),
        PortableHost::new("http://192.168.1.20:3000", None),
    ]
}

#[test]
fn reads_back_the_same_list_from_its_code_its_link_and_its_file() {
    let list = hosts();
    assert_eq!(read_host_list(&encode_host_list(&list)), Some(list.clone()));
    assert_eq!(read_host_list(&host_list_link(&list)), Some(list.clone()));
    assert_eq!(read_host_list(&host_list_file(&list)), Some(list.clone()));
    assert_eq!(
        read_host_list(&format!("  {}\n", encode_host_list(&list))),
        Some(list)
    );
}

#[test]
fn writes_the_compact_code_and_the_readable_file_the_other_apps_read() {
    let list = hosts();
    let code = encode_host_list(&list);
    // [["polaris.example.com","Home"],["http://192.168.1.20:3000"]], base64url.
    assert_eq!(
        code,
        "polaris-hosts:1:W1sicG9sYXJpcy5leGFtcGxlLmNvbSIsIkhvbWUiXSxbImh0dHA6Ly8xOTIuMTY4LjEuMjA6MzAwMCJdXQ"
    );
    let file = host_list_file(&list);
    assert!(file.starts_with("{\n    \"kind\": \"polaris-hosts\",\n    \"version\": 1,\n"));
    assert!(file.ends_with("}\n"));
}

#[test]
fn reads_an_empty_list_as_a_list_and_anything_else_as_nothing() {
    assert_eq!(read_host_list(&encode_host_list(&[])), Some(vec![]));
    for text in [
        "",
        "hello",
        "polaris-hosts:1:@@@",
        "{}",
        r#"{"kind":"other","hosts":[]}"#,
        "polaris://hosts?x=1",
    ] {
        assert_eq!(read_host_list(text), None, "{text}");
    }
}

#[test]
fn keeps_only_bare_http_addresses_once_each_and_caps_names_and_the_list() {
    let mut rows = vec![
        json!({ "origin": "javascript:alert(1)", "name": "x" }),
        json!({ "origin": "https://user:pw@evil.example", "name": "x" }),
        json!({ "origin": "https://polaris.example.com/path", "name": "x" }),
        json!({ "origin": "ftp://files.example", "name": "x" }),
        json!({ "origin": "https://ok.example", "name": format!("  {}  ", "n".repeat(80)) }),
        json!({ "origin": "https://ok.example", "name": "duplicate" }),
    ];
    rows.extend((0..80).map(|i| json!({ "origin": format!("https://h{i}.example"), "name": 7 })));
    let file = json!({ "kind": "polaris-hosts", "version": 1, "hosts": rows }).to_string();
    let read = read_host_list(&file).unwrap();
    assert_eq!(
        read[0],
        PortableHost::new("https://ok.example", Some(&"n".repeat(40)))
    );
    assert_eq!(read.len(), HOST_LIST_MAX);
    assert!(read.iter().all(|one| one.origin.starts_with("https://")));
    assert_eq!(read[1].name, None);
}

#[test]
fn refuses_a_text_too_long_to_be_a_list() {
    assert_eq!(
        read_host_list(&format!("polaris-hosts:1:{}", "A".repeat(70_000))),
        None
    );
}

#[test]
fn adds_what_is_new_names_what_was_unnamed_and_never_renames_or_drops_silently() {
    let saved = vec![
        PortableHost::new("https://polaris.example.com", Some("Mine")),
        PortableHost::new("http://192.168.1.20:3000", None),
    ];
    let incoming = vec![
        PortableHost::new("https://polaris.example.com", Some("Theirs")),
        PortableHost::new("http://192.168.1.20:3000", Some("Lab")),
        PortableHost::new("https://a.example", None),
        PortableHost::new("https://b.example", None),
    ];
    let merged = merge_host_lists(&saved, &incoming, 3);
    assert_eq!(
        merged.hosts,
        vec![
            PortableHost::new("https://polaris.example.com", Some("Mine")),
            PortableHost::new("http://192.168.1.20:3000", Some("Lab")),
            PortableHost::new("https://a.example", None),
        ]
    );
    assert_eq!((merged.added, merged.named, merged.skipped), (1, 1, 1));
}

#[test]
fn a_list_taken_in_adds_new_hosts_after_the_kept_ones_and_names_an_unnamed_one() {
    let kept = vec![
        PortableHost::new("https://polaris.example.com", None),
        PortableHost::new("https://mine.example.com", Some("Mine")),
    ];
    let code = encode_host_list(&[
        PortableHost::new("https://polaris.example.com", Some("Casa")),
        PortableHost::new("https://mine.example.com", Some("Theirs")),
        PortableHost::new("http://192.168.1.20:3000", None),
    ]);
    let merged = merge_host_lists(&kept, &read_host_list(&code).unwrap(), 20);
    assert_eq!((merged.added, merged.named, merged.skipped), (1, 1, 0));
    assert_eq!(
        merged.hosts,
        vec![
            PortableHost::new("https://polaris.example.com", Some("Casa")),
            PortableHost::new("https://mine.example.com", Some("Mine")),
            PortableHost::new("http://192.168.1.20:3000", None),
        ]
    );
}

#[test]
fn counts_the_hosts_that_do_not_fit_instead_of_dropping_them_silently() {
    let full: Vec<_> = (0..20)
        .map(|i| PortableHost::new(&format!("https://h{i}.example"), None))
        .collect();
    let incoming = read_host_list(&encode_host_list(&[PortableHost::new(
        "https://new.example",
        None,
    )]))
    .unwrap();
    let merged = merge_host_lists(&full, &incoming, 20);
    assert_eq!((merged.added, merged.named, merged.skipped), (0, 0, 1));
}

#[test]
fn the_qr_holds_a_short_or_long_list_and_says_when_a_text_fits_no_code() {
    let many: Vec<_> = (0..20)
        .map(|i| {
            PortableHost::new(
                &format!("https://host-{i}.example.com"),
                Some(&format!("Host {i}")),
            )
        })
        .collect();
    for text in [host_list_link(&hosts()), host_list_link(&many)] {
        let modules = encode_qr(&text).expect("a list fits a code");
        assert!(modules.len() >= 21 && modules.len() <= 177);
        assert!(modules.iter().all(|row| row.len() == modules.len()));
    }
    assert_eq!(encode_qr(&"x".repeat(3000)), None);
}

#[test]
fn the_qr_is_drawn_with_its_quiet_zone() {
    let modules = encode_qr("https://polaris.example.com").unwrap();
    let (path, size) = qr_svg_path(&modules);
    assert_eq!(size, modules.len() + 8);
    // The finder pattern's top-left module sits just inside the quiet zone.
    assert!(path.starts_with("M4 4h1v1h-1z"));
}
