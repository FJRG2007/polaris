use std::collections::HashMap;

use super::default_pane_name_for_path;

/// Runs the lookup against a map written inline, so each case below reads as
/// the configuration a user would type and the directory a pane would be in.
fn name_for(configured: &[(&str, &str)], path: &str) -> Option<String> {
    let names: HashMap<String, String> = configured
        .iter()
        .map(|(path, name)| ((*path).to_owned(), (*name).to_owned()))
        .collect();
    default_pane_name_for_path(&names, path).map(str::to_owned)
}

#[test]
fn names_the_directory_it_was_configured_for() {
    let names = [("/home/me/polaris-terminal", "Polaris Terminal")];
    assert_eq!(
        name_for(&names, "/home/me/polaris-terminal").as_deref(),
        Some("Polaris Terminal")
    );
}

#[test]
fn covers_the_directories_inside_it() {
    let names = [("/home/me/polaris-terminal", "Polaris Terminal")];
    let inside = "/home/me/polaris-terminal/app/src";
    assert_eq!(
        name_for(&names, inside).as_deref(),
        Some("Polaris Terminal")
    );
}

#[test]
fn the_longest_configured_path_wins() {
    let names = [
        ("/home/me/polaris-terminal", "Polaris Terminal"),
        ("/home/me/polaris-terminal/app", "App"),
    ];
    let in_app = "/home/me/polaris-terminal/app/src";
    assert_eq!(name_for(&names, in_app).as_deref(), Some("App"));

    let in_crates = "/home/me/polaris-terminal/crates";
    assert_eq!(
        name_for(&names, in_crates).as_deref(),
        Some("Polaris Terminal")
    );
}

#[test]
fn a_prefix_that_stops_mid_component_is_not_a_match() {
    let names = [("/home/me/roo", "Wrong")];
    assert_eq!(name_for(&names, "/home/me/polaris-terminal"), None);
}

#[test]
fn the_separator_and_a_trailing_one_do_not_have_to_agree() {
    let names = [("C:\\dev\\polaris-terminal\\", "Polaris Terminal")];
    assert_eq!(
        name_for(&names, "C:/dev/polaris-terminal/app").as_deref(),
        Some("Polaris Terminal")
    );
}

#[test]
fn a_blank_name_is_not_a_name() {
    let names = [("/home/me/polaris-terminal", "   ")];
    assert_eq!(name_for(&names, "/home/me/polaris-terminal"), None);
}

#[test]
fn an_unconfigured_directory_has_no_name() {
    let names = [("/home/me/polaris-terminal", "Polaris Terminal")];
    assert_eq!(name_for(&names, "/home/me/other"), None);
}

/// Windows and macOS fold case in the filesystem, so a drive letter or a home
/// directory typed the other way still has to name the pane.
#[cfg(not(target_os = "linux"))]
#[test]
fn case_is_ignored_where_the_filesystem_ignores_it() {
    let names = [("C:/Users/Me/Polaris-Terminal", "Polaris Terminal")];
    let same_path = "c:/users/me/polaris-terminal/app";
    assert_eq!(
        name_for(&names, same_path).as_deref(),
        Some("Polaris Terminal")
    );
}

/// Linux does not fold it, and two directories differing only in case are two
/// different directories, so neither may borrow the other's name.
#[cfg(target_os = "linux")]
#[test]
fn case_matters_where_the_filesystem_makes_it_matter() {
    let names = [("/home/me/Polaris-Terminal", "Polaris Terminal")];
    assert_eq!(name_for(&names, "/home/me/polaris-terminal"), None);
}
