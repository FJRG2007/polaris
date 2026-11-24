use std::time::Duration;

use instant::Instant;

use super::{FAILED_DIRECTORY_TTL, FailedDirectory, format_branch_status};

#[test]
fn branch_status_without_upstream_difference_is_the_branch() {
    assert_eq!(format_branch_status("main", "0\t0\t0\n"), "main");
}

#[test]
fn branch_status_shows_ahead_and_behind() {
    assert_eq!(format_branch_status("main", "2\t0\t0\n"), "main • ↑2");
    assert_eq!(format_branch_status("main", "0\t3\t0\n"), "main • ↓3");
    assert_eq!(format_branch_status("main", "2\t3\t1\n"), "main • ↑2 ↓3");
}

#[test]
fn branch_status_shows_equivalent_commits_when_otherwise_even() {
    assert_eq!(format_branch_status("main", "0\t0\t4\n"), "main • ⇅");
}

#[test]
fn branch_status_caps_large_counts() {
    assert_eq!(
        format_branch_status("main", "1000\t999\t0\n"),
        "main • ↑999+ ↓999"
    );
}

#[test]
fn branch_status_falls_back_to_the_branch_on_unexpected_counts() {
    assert_eq!(format_branch_status("main", ""), "main");
    assert_eq!(format_branch_status("main", "5"), "main");
    assert_eq!(format_branch_status("main", "a\tb\tc"), "main");
}

#[test]
fn branch_status_without_equivalent_count_treats_it_as_zero() {
    assert_eq!(
        format_branch_status("feature/x", "1 2"),
        "feature/x • ↑1 ↓2"
    );
}

#[test]
fn failed_directory_covers_the_same_directory_until_the_ttl() {
    let start = Instant::now();
    let mut failed = FailedDirectory::default();
    failed.record(Some("C:\\Users\\dev"), start);

    assert!(failed.covers(Some("C:\\Users\\dev"), start));
    assert!(failed.covers(
        Some("C:\\Users\\dev"),
        start + FAILED_DIRECTORY_TTL - Duration::from_secs(1)
    ));
    assert!(!failed.covers(Some("C:\\Users\\dev"), start + FAILED_DIRECTORY_TTL));
}

#[test]
fn failed_directory_does_not_cover_other_directories() {
    let start = Instant::now();
    let mut failed = FailedDirectory::default();
    failed.record(Some("C:\\Users\\dev"), start);

    assert!(!failed.covers(Some("C:\\Users\\dev\\repo"), start));
    assert!(!failed.covers(None, start));
}

#[test]
fn failed_directory_is_forgotten_when_cleared_or_recorded_without_a_directory() {
    let start = Instant::now();
    let mut failed = FailedDirectory::default();
    assert!(!failed.covers(Some("C:\\Users\\dev"), start));

    failed.record(Some("C:\\Users\\dev"), start);
    failed.clear();
    assert!(!failed.covers(Some("C:\\Users\\dev"), start));

    failed.record(Some("C:\\Users\\dev"), start);
    failed.record(None, start);
    assert!(!failed.covers(Some("C:\\Users\\dev"), start));
}
