//! `desktop/test/shared/mailto.test.ts`, ported: a mailto link opens the
//! composer on the Polaris in use, and nothing else.

use polaris_client::mailto::{mailto_in, mailto_path};
use polaris_client::navigation::server_path;

#[test]
fn opens_the_composer_with_the_whole_link_for_the_web_app_to_read() {
    let link = "mailto:someone@example.com?subject=Hi%20there&body=A%26B";
    assert_eq!(
        mailto_path(link).as_deref(),
        Some("/mail/compose?url=mailto%3Asomeone%40example.com%3Fsubject%3DHi%2520there%26body%3DA%2526B")
    );
}

#[test]
fn takes_the_scheme_in_any_case() {
    assert!(mailto_path("MAILTO:someone@example.com").is_some());
}

#[test]
fn stays_a_path_on_the_server_in_use() {
    let path = mailto_path(r"mailto:a@example.com?body=\\evil//x").expect("a path");
    let url = server_path(&path, "https://polaris.example").expect("on the server");
    assert!(
        url.starts_with("https://polaris.example/mail/compose?url="),
        "{url}"
    );
}

#[test]
fn refuses_what_is_not_one() {
    assert_eq!(mailto_path("https://example.com"), None);
    assert_eq!(mailto_path("polaris://open?server=x"), None);
    assert_eq!(mailto_path("mailto:a@example.com\nInjected: yes"), None);
    assert_eq!(
        mailto_path(&format!("mailto:{}@example.com", "a".repeat(9000))),
        None
    );
}

#[test]
fn is_found_among_the_arguments_windows_starts_the_app_with() {
    let argv = |list: &[&str]| list.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        mailto_in(&argv(&[
            r"C:\Polaris\polaris.exe",
            "--flag",
            "mailto:a@example.com"
        ]))
        .as_deref(),
        Some("/mail/compose?url=mailto%3Aa%40example.com")
    );
    assert_eq!(mailto_in(&argv(&[r"C:\Polaris\polaris.exe"])), None);
}
