//! Updating the app: which release is newer, updating before opening, the update
//! waiting for a restart and the macOS signature check. Ported from
//! desktop/test/main/releases.test.ts, update-first.test.ts, update-ready.test.ts
//! and mac-signature.test.ts.

use polaris_client::mac_signature::team_identifier;
use polaris_client::releases::{
    app_image_asset, mac_feed_name, newer_release, parse_checksums, parse_version, release_source,
    Asset, BETA_TAG_PREFIX, CHECKSUMS, TAG_PREFIX,
};
use polaris_client::update_first::{
    update_before_opening, FirstCheck, Opening, OpeningSteps, CHECK_BEFORE_OPENING,
    RESTART_BEFORE_OPENING, SETTLE_BEFORE_ASKING, UPDATE_BEFORE_OPENING,
};
use polaris_client::update_ready::{
    read_update_ready, FoundUpdate, Restart, UpdateReady, UpdateReadyState,
};
use serde_json::{json, Value};
use std::future::{pending, ready, Future};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::time::sleep_until;

fn repo_file(path: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::read_to_string(root.join(path)).expect("the repository file is there")
}

// --- releases ---------------------------------------------------------------

fn release(tag: &str, draft: bool, prerelease: bool) -> Value {
    json!({
        "tag_name": tag,
        "draft": draft,
        "prerelease": prerelease,
        "html_url": format!("https://github.com/example/repo/releases/tag/{tag}"),
    })
}

fn published(tag: &str) -> Value {
    release(tag, false, false)
}

#[test]
fn reads_a_plain_version_and_nothing_else() {
    assert_eq!(parse_version("0.1.0"), Some([0, 1, 0]));
    assert_eq!(parse_version("12.0.3"), Some([12, 0, 3]));
    assert_eq!(parse_version("1.2.0-beta.1"), None);
    assert_eq!(parse_version("v1.2.0"), None);
    assert_eq!(parse_version("1.2"), None);
    assert_eq!(parse_version("1.2.3.4"), None);
    assert_eq!(parse_version("1.+2.3"), None);
}

#[test]
fn picks_the_highest_published_desktop_version_above_the_running_one() {
    let list = json!([
        published("v3.0.0"),
        published("desktop-v0.2.0"),
        published("desktop-v0.10.0"),
        published("desktop-v0.9.1"),
        release("desktop-v1.0.0", true, false),
        release("desktop-v0.11.0", false, true),
        published("desktop-v0.12.0-rc.1"),
    ]);
    let found = newer_release(&list, "0.1.0", TAG_PREFIX).expect("a newer release");
    assert_eq!(found.version, "0.10.0");
    assert_eq!(found.tag, "desktop-v0.10.0");
}

#[test]
fn answers_none_when_the_running_version_is_the_newest_or_is_not_a_version() {
    let list = json!([published("desktop-v0.1.0"), published("desktop-v0.0.9")]);
    assert_eq!(newer_release(&list, "0.1.0", TAG_PREFIX), None);
    assert_eq!(
        newer_release(&json!([published("desktop-v0.2.0")]), "dev", TAG_PREFIX),
        None
    );
}

#[test]
fn answers_none_for_anything_that_is_not_a_release_list() {
    for body in [
        json!({ "message": "API rate limit exceeded" }),
        json!([{ "tag_name": 7 }]),
        Value::Null,
    ] {
        assert_eq!(newer_release(&body, "0.1.0", TAG_PREFIX), None);
    }
}

#[test]
fn the_beta_and_the_electron_app_never_read_each_others_releases() {
    assert!(!BETA_TAG_PREFIX.starts_with(TAG_PREFIX));
    assert!(!TAG_PREFIX.starts_with(BETA_TAG_PREFIX));
    let list = json!([
        published("desktop-v0.5.0"),
        published("desktop-tauri-v0.3.0")
    ]);
    assert_eq!(
        newer_release(&list, "0.1.0", TAG_PREFIX).map(|found| found.tag),
        Some("desktop-v0.5.0".to_owned())
    );
    assert_eq!(
        newer_release(&list, "0.1.0", BETA_TAG_PREFIX).map(|found| found.tag),
        Some("desktop-tauri-v0.3.0".to_owned())
    );
}

#[test]
fn reads_the_repository_and_matches_the_workflows_tag_prefix() {
    let source = release_source(env!("CARGO_PKG_REPOSITORY")).expect("a GitHub repository");
    let api = source.api();
    assert!(
        api.starts_with("https://api.github.com/repos/") && api.ends_with("/releases?per_page=100")
    );
    assert!(source
        .page(&format!("{TAG_PREFIX}1.2.3"))
        .ends_with("/releases/tag/desktop-v1.2.3"));
    // Squirrel reads RELEASES and the package from beside each other.
    assert!(source
        .download(&format!("{TAG_PREFIX}1.2.3"))
        .ends_with("/releases/download/desktop-v1.2.3"));

    let workflows =
        std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows"))
            .expect("the workflows are there");
    let desktop = repo_file(".github/workflows/desktop.yml");
    assert!(desktop.contains(&format!("- \"{TAG_PREFIX}*\"")));
    // No workflow publishes the beta.
    for workflow in workflows {
        let text = std::fs::read_to_string(workflow.unwrap().path()).unwrap_or_default();
        assert!(!text.contains(BETA_TAG_PREFIX));
    }
}

#[test]
fn takes_the_usual_spellings_of_a_github_repository_and_refuses_anything_else() {
    assert_eq!(
        release_source("git+https://github.com/owner/repo.git").map(|source| source.api()),
        Some("https://api.github.com/repos/owner/repo/releases?per_page=100".to_owned())
    );
    assert_eq!(
        release_source("https://github.com/owner/repo/").map(|source| source.api()),
        Some("https://api.github.com/repos/owner/repo/releases?per_page=100".to_owned())
    );
    assert_eq!(release_source("https://gitlab.com/owner/repo"), None);
    assert_eq!(release_source("https://github.com/owner"), None);
    assert_eq!(release_source("https://github.com/owner/repo/extra"), None);
    let source = release_source("https://github.com/owner/repo").unwrap();
    assert_eq!(
        source.page("a b/c"),
        "https://github.com/owner/repo/releases/tag/a%20b%2Fc"
    );
}

fn sha(character: &str) -> String {
    character.repeat(64)
}

fn asset(name: &str, size: u64) -> Asset {
    Asset {
        name: name.to_owned(),
        size,
    }
}

#[test]
fn carries_the_releases_files_with_the_version_it_picks() {
    let mut with_files = published("desktop-v0.2.0");
    with_files["assets"] =
        json!([{ "name": "Polaris-0.2.0-x64.AppImage", "size": 10, "url": "ignored" }]);
    assert_eq!(
        newer_release(&json!([with_files]), "0.1.0", TAG_PREFIX)
            .unwrap()
            .assets,
        vec![asset("Polaris-0.2.0-x64.AppImage", 10)]
    );
    assert_eq!(
        newer_release(&json!([published("desktop-v0.2.0")]), "0.1.0", TAG_PREFIX)
            .unwrap()
            .assets,
        vec![]
    );
}

#[test]
fn reads_sha256sum_output_and_drops_what_is_not_a_line_of_it() {
    let text = [
        format!("{}  Polaris-0.2.0-x64.AppImage", sha("A")),
        format!("{} *polaris-0.2.0-full.nupkg\r", sha("b")),
        "not a line".to_owned(),
        sha("c"),
        String::new(),
    ]
    .join("\n");
    let sums = parse_checksums(&text);
    assert_eq!(sums.get("Polaris-0.2.0-x64.AppImage"), Some(&sha("a")));
    assert_eq!(sums.get("polaris-0.2.0-full.nupkg"), Some(&sha("b")));
    assert_eq!(sums.len(), 2);
}

#[test]
fn trusts_no_digest_for_a_name_listed_twice() {
    let sums = parse_checksums(&format!(
        "{}  Polaris.AppImage\n{}  Polaris.AppImage\n",
        sha("a"),
        sha("b")
    ));
    assert!(!sums.contains_key("Polaris.AppImage"));
}

#[test]
fn picks_the_one_app_image_for_this_architecture() {
    let assets = [
        asset("Polaris-0.2.0-x64.AppImage", 10),
        asset("Polaris-0.2.0-arm64.AppImage", 10),
        asset("polaris-desktop_0.2.0_amd64.deb", 10),
        asset(CHECKSUMS, 10),
    ];
    assert_eq!(
        app_image_asset(&assets, "x64").map(|found| found.name.as_str()),
        Some("Polaris-0.2.0-x64.AppImage")
    );
    assert_eq!(
        app_image_asset(&assets, "arm64").map(|found| found.name.as_str()),
        Some("Polaris-0.2.0-arm64.AppImage")
    );
    assert_eq!(app_image_asset(&assets, "ia32"), None);
    assert_eq!(
        app_image_asset(&[asset("Polaris-0.2.0-x64.AppImage", 0)], "x64"),
        None
    );
    assert_eq!(
        app_image_asset(
            &[
                asset("Polaris-x64.AppImage", 1),
                asset("Polaris-x86_64.AppImage", 1)
            ],
            "x64"
        ),
        None
    );
}

#[test]
fn names_the_macos_feed_and_the_checksums_the_way_the_release_job_writes_them() {
    assert_eq!(mac_feed_name("arm64"), "RELEASES-darwin-arm64.json");
    assert!(repo_file("desktop/build/mac-feed.cjs").contains("`RELEASES-darwin-${arch}.json`"));
    let workflow = repo_file(".github/workflows/desktop.yml");
    assert!(workflow.contains(CHECKSUMS));
    assert!(workflow.contains("build/mac-feed.cjs"));
}

// --- updating before opening --------------------------------------------------

#[derive(Default)]
struct Steps {
    attempted: Option<String>,
    attempt_fails: bool,
    opened: bool,
    /// Whether the updating window is closed as soon as it shows.
    closes: bool,
    restart_fails: bool,
    log: Vec<String>,
    shown: usize,
}

impl OpeningSteps for Steps {
    fn attempted(&mut self) -> Option<String> {
        self.attempted.clone()
    }
    fn attempt(&mut self, version: &str) -> Result<(), String> {
        self.log.push(format!("attempt {version}"));
        if self.attempt_fails {
            return Err("disk full".to_owned());
        }
        Ok(())
    }
    fn opened(&mut self) -> bool {
        self.opened
    }
    fn show_updating(&mut self) -> impl Future<Output = ()> {
        self.shown += 1;
        let closes = self.closes;
        async move {
            if !closes {
                pending::<()>().await;
            }
        }
    }
    fn restart(&mut self) -> bool {
        self.log.push("restart".to_owned());
        !self.restart_fails
    }
}

impl Steps {
    fn restarts(&self) -> usize {
        self.log.iter().filter(|line| *line == "restart").count()
    }
}

/// A check that answers `0.1.3` at once and installs it.
fn found_at_once() -> FirstCheck<
    impl Future<Output = ()>,
    impl Future<Output = Option<String>>,
    impl Future<Output = bool>,
> {
    FirstCheck {
        asked: ready(()),
        installing: ready(Some("0.1.3".to_owned())),
        installed: ready(true),
    }
}

/// `value` once `delay` has passed since `from`, as a check already running
/// settles: counted from the start, not from when it is first awaited.
async fn after<T>(from: tokio::time::Instant, delay: Duration, value: T) -> T {
    sleep_until(from + delay).await;
    value
}

#[tokio::test(start_paused = true)]
async fn restarts_into_a_version_found_at_once_remembering_it_first() {
    let mut steps = Steps::default();
    update_before_opening(found_at_once(), &mut steps).await;
    assert_eq!(steps.shown, 1);
    assert_eq!(steps.log, ["attempt 0.1.3", "restart"]);
}

#[tokio::test(start_paused = true)]
async fn opens_the_app_when_nothing_is_going_in() {
    let mut steps = Steps::default();
    let first = FirstCheck {
        asked: ready(()),
        installing: ready(None),
        installed: ready(true),
    };
    assert_eq!(
        update_before_opening(first, &mut steps).await,
        Opening::Open
    );
    assert_eq!(steps.shown, 0);
}

#[tokio::test(start_paused = true)]
async fn opens_the_app_when_the_answer_is_slow() {
    let mut steps = Steps::default();
    let started = tokio::time::Instant::now();
    let first = FirstCheck {
        asked: ready(()),
        installing: pending::<Option<String>>(),
        installed: ready(true),
    };
    assert_eq!(
        update_before_opening(first, &mut steps).await,
        Opening::Open
    );
    assert_eq!(started.elapsed(), CHECK_BEFORE_OPENING);
    assert_eq!(steps.shown, 0);
}

#[tokio::test(start_paused = true)]
async fn gives_the_answer_its_full_time_after_a_slow_signature_check() {
    let asked = Duration::from_millis(4_000);
    let start = tokio::time::Instant::now();
    let mut steps = Steps::default();
    let first = FirstCheck {
        asked: after(start, asked, ()),
        installing: after(
            start,
            asked + CHECK_BEFORE_OPENING - Duration::from_millis(1),
            Some("0.1.3".to_owned()),
        ),
        installed: ready(true),
    };
    update_before_opening(first, &mut steps).await;
    assert_eq!(steps.restarts(), 1);

    let mut late = Steps::default();
    let start = tokio::time::Instant::now();
    let first = FirstCheck {
        asked: after(start, asked, ()),
        installing: after(
            start,
            asked + CHECK_BEFORE_OPENING + Duration::from_millis(1),
            Some("0.1.3".to_owned()),
        ),
        installed: ready(true),
    };
    assert_eq!(update_before_opening(first, &mut late).await, Opening::Open);
    assert_eq!(late.restarts(), 0);
}

#[tokio::test(start_paused = true)]
async fn does_not_wait_for_ever_on_a_signature_check() {
    let started = tokio::time::Instant::now();
    let first = FirstCheck {
        asked: pending::<()>(),
        installing: pending::<Option<String>>(),
        installed: pending::<bool>(),
    };
    assert_eq!(
        update_before_opening(first, &mut Steps::default()).await,
        Opening::Open
    );
    assert_eq!(
        started.elapsed(),
        SETTLE_BEFORE_ASKING + CHECK_BEFORE_OPENING
    );
}

#[tokio::test(start_paused = true)]
async fn opens_as_it_is_when_this_version_was_tried_and_did_not_take() {
    let mut steps = Steps {
        attempted: Some("0.1.3".to_owned()),
        ..Steps::default()
    };
    assert_eq!(
        update_before_opening(found_at_once(), &mut steps).await,
        Opening::Open
    );
    assert_eq!(steps.shown, 0);
    assert_eq!(steps.restarts(), 0);
}

#[tokio::test(start_paused = true)]
async fn tries_a_newer_version_than_the_one_that_did_not_take() {
    let mut steps = Steps {
        attempted: Some("0.1.2".to_owned()),
        ..Steps::default()
    };
    update_before_opening(found_at_once(), &mut steps).await;
    assert_eq!(steps.restarts(), 1);
}

#[tokio::test(start_paused = true)]
async fn leaves_an_app_already_opened_alone() {
    let mut steps = Steps {
        opened: true,
        ..Steps::default()
    };
    assert_eq!(
        update_before_opening(found_at_once(), &mut steps).await,
        Opening::Open
    );
    assert_eq!(steps.shown, 0);
}

#[tokio::test(start_paused = true)]
async fn opens_and_does_not_hold_the_next_start_when_the_install_fails() {
    let mut steps = Steps::default();
    let first = FirstCheck {
        asked: ready(()),
        installing: ready(Some("0.1.3".to_owned())),
        installed: ready(false),
    };
    assert_eq!(
        update_before_opening(first, &mut steps).await,
        Opening::Open
    );
    assert_eq!(steps.log, ["attempt 0.1.3"]);
}

#[tokio::test(start_paused = true)]
async fn opens_and_does_not_hold_the_next_start_when_the_install_takes_too_long() {
    let mut steps = Steps::default();
    let started = tokio::time::Instant::now();
    let first = FirstCheck {
        asked: ready(()),
        installing: ready(Some("0.1.3".to_owned())),
        installed: pending::<bool>(),
    };
    assert_eq!(
        update_before_opening(first, &mut steps).await,
        Opening::Open
    );
    assert_eq!(started.elapsed(), UPDATE_BEFORE_OPENING);
    assert_eq!(steps.log, ["attempt 0.1.3"]);
}

#[tokio::test(start_paused = true)]
async fn opens_the_app_when_a_restart_returned_and_left_it_running() {
    let mut steps = Steps::default();
    let started = tokio::time::Instant::now();
    assert_eq!(
        update_before_opening(found_at_once(), &mut steps).await,
        Opening::Open
    );
    assert_eq!(steps.restarts(), 1);
    assert_eq!(started.elapsed(), RESTART_BEFORE_OPENING);
}

#[tokio::test(start_paused = true)]
async fn does_not_restart_once_the_updating_window_is_closed() {
    let mut steps = Steps {
        closes: true,
        ..Steps::default()
    };
    assert_eq!(
        update_before_opening(found_at_once(), &mut steps).await,
        Opening::Closed
    );
    assert_eq!(steps.restarts(), 0);
}

#[tokio::test(start_paused = true)]
async fn opens_the_app_at_once_when_the_restart_fails() {
    let mut steps = Steps {
        restart_fails: true,
        ..Steps::default()
    };
    let started = tokio::time::Instant::now();
    assert_eq!(
        update_before_opening(found_at_once(), &mut steps).await,
        Opening::Open
    );
    assert_eq!(started.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn does_not_restart_when_the_attempt_cannot_be_remembered_which_could_loop() {
    let mut steps = Steps {
        attempt_fails: true,
        ..Steps::default()
    };
    assert_eq!(
        update_before_opening(found_at_once(), &mut steps).await,
        Opening::Open
    );
    assert_eq!(steps.restarts(), 0);
    assert_eq!(steps.shown, 0);
}

// --- the update waiting for a restart -----------------------------------------

type Told = Arc<Mutex<Vec<Option<UpdateReady>>>>;

fn state() -> (UpdateReadyState, Told) {
    let told: Told = Arc::default();
    let sink = told.clone();
    let state = UpdateReadyState::new(move |ready| sink.lock().unwrap().push(ready.cloned()));
    (state, told)
}

fn counting() -> (Restart, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let counted = count.clone();
    let restart: Restart = Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    (restart, count)
}

fn installed(version: &str, restart: &Restart) -> FoundUpdate {
    FoundUpdate {
        version: version.to_owned(),
        restart: Some(restart.clone()),
    }
}

fn page_only(version: &str) -> FoundUpdate {
    FoundUpdate {
        version: version.to_owned(),
        restart: None,
    }
}

fn ready_version(version: &str) -> Option<UpdateReady> {
    Some(UpdateReady {
        version: version.to_owned(),
    })
}

#[test]
fn holds_nothing_until_an_installed_update_is_found() {
    let (mut state, told) = state();
    assert_eq!(state.current(), None);
    assert!(state.install().is_err());
    assert!(told.lock().unwrap().is_empty());
}

#[test]
fn ignores_an_update_that_can_only_be_downloaded_from_its_page() {
    let (mut state, told) = state();
    state.found(&page_only("0.1.3"));
    assert_eq!(state.current(), None);
    assert!(told.lock().unwrap().is_empty());
}

#[test]
fn tells_the_pages_once_when_an_update_is_ready_and_restarts_into_it_once() {
    let (mut state, told) = state();
    let (restart, count) = counting();
    state.found(&installed("0.1.3", &restart));
    state.found(&installed("0.1.3", &restart));
    assert_eq!(*told.lock().unwrap(), vec![ready_version("0.1.3")]);
    assert_eq!(state.current().cloned(), ready_version("0.1.3"));
    assert_eq!(state.install(), Ok(()));
    assert_eq!(state.install(), Ok(()));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn keeps_an_installed_update_when_a_newer_one_could_only_be_offered_as_a_page() {
    let (mut state, _) = state();
    let (restart, _) = counting();
    state.found(&installed("0.1.3", &restart));
    state.found(&page_only("0.1.4"));
    assert_eq!(state.current().cloned(), ready_version("0.1.3"));
}

#[test]
fn moves_to_a_newer_installed_update_and_lets_it_be_installed() {
    let (mut state, told) = state();
    let (older, older_count) = counting();
    let (newer, newer_count) = counting();
    state.found(&installed("0.1.3", &older));
    state.found(&installed("0.1.4", &newer));
    assert_eq!(
        told.lock().unwrap().last().cloned(),
        Some(ready_version("0.1.4"))
    );
    let _ = state.install();
    assert_eq!(older_count.load(Ordering::SeqCst), 0);
    assert_eq!(newer_count.load(Ordering::SeqCst), 1);
}

#[test]
fn answers_a_failed_restart_as_a_sentence_and_lets_it_be_tried_again() {
    let (mut state, _) = state();
    let count = Arc::new(AtomicUsize::new(0));
    let counted = count.clone();
    let restart: Restart = Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Err("the installer said no".to_owned())
    });
    state.found(&installed("0.1.3", &restart));
    let outcome = state.install();
    let error = outcome.expect_err("the restart failed");
    assert!(!error.contains("installer said"));
    let _ = state.install();
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[test]
fn lets_a_restart_that_returned_and_left_the_app_running_be_asked_for_again() {
    let (mut state, _) = state();
    let (restart, count) = counting();
    state.found(&installed("0.1.3", &restart));
    let start = Instant::now();
    let _ = state.install_at(start);
    let _ = state.install_at(start + RESTART_BEFORE_OPENING - Duration::from_millis(1));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(state.install_at(start + RESTART_BEFORE_OPENING), Ok(()));
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[test]
fn never_holds_a_version_that_is_not_one() {
    let (mut state, told) = state();
    let (restart, _) = counting();
    state.found(&installed("<img src=x>", &restart));
    assert_eq!(state.current(), None);
    assert!(told.lock().unwrap().is_empty());
}

#[test]
fn counts_no_page_until_one_says_it_draws_the_button() {
    let (state, _) = state();
    assert!(!state.offered_by(Some("main")));
    assert!(!state.offered_by(None));
}

#[test]
fn follows_each_windows_page_on_its_own() {
    let (mut state, _) = state();
    state.offer("one", true);
    state.offer("two", true);
    assert!(state.offered_by(Some("one")));
    assert!(state.offered_by(Some("two")));
    state.offer("one", false);
    assert!(!state.offered_by(Some("one")));
    assert!(state.offered_by(Some("two")));
    assert!(!state.offered_by(Some("three")));
}

#[test]
fn announces_an_installed_update_itself_unless_the_page_in_front_draws_the_button() {
    let (mut state, _) = state();
    let (restart, _) = counting();
    let update = installed("0.1.3", &restart);
    // An older dashboard, the servers page, no window at all.
    assert!(state.needs_notice(&update, Some("one")));
    assert!(state.needs_notice(&update, None));
    state.offer("one", true);
    assert!(!state.needs_notice(&update, Some("one")));
    // Another window in front, on a page without the button.
    assert!(state.needs_notice(&update, Some("two")));
    // A download page is never the button's.
    assert!(state.needs_notice(&page_only("0.1.4"), Some("one")));
}

#[test]
fn reads_a_ready_update_and_nothing_else() {
    assert_eq!(
        read_update_ready(&json!({ "version": "0.1.3" })),
        ready_version("0.1.3")
    );
    assert_eq!(
        read_update_ready(&json!({ "version": "1.0.0-beta.2" })),
        ready_version("1.0.0-beta.2")
    );
    for raw in [
        Value::Null,
        json!({ "version": 3 }),
        json!({ "version": "0.1.3", "restart": "now" }),
        json!("0.1.3"),
        json!({ "version": "1.2" }),
        json!({ "version": "1.2.3-" }),
        json!({ "version": format!("1.2.3-{}", "x".repeat(59)) }),
    ] {
        assert_eq!(read_update_ready(&raw), None, "{raw}");
    }
    assert!(
        read_update_ready(&json!({ "version": format!("1.2.3-{}", "x".repeat(58)) })).is_some()
    );
}

// --- the macOS signature ------------------------------------------------------

#[test]
fn reads_the_team_of_a_developer_id_signature() {
    let output = [
        "Executable=/Applications/Polaris.app/Contents/MacOS/Polaris",
        "Authority=Developer ID Application: Example (AB12CD34EF)",
        "TeamIdentifier=AB12CD34EF",
        "",
    ]
    .join("\n");
    assert_eq!(team_identifier(&output), Some("AB12CD34EF"));
}

#[test]
fn finds_no_team_in_an_ad_hoc_signature_or_in_no_output() {
    assert_eq!(
        team_identifier("Signature=adhoc\nTeamIdentifier=not set\n"),
        None
    );
    assert_eq!(team_identifier(""), None);
}
