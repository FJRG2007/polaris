//! The pure window rules: navigation, permissions, window failover and
//! `polaris://` links. Ported from desktop/test/main/navigation.test.ts,
//! window-failover.test.ts, deep-links.test.ts and shared/deep-link.test.ts.

use polaris_client::deep_link::{
    deep_link_in, deep_link_route, read_deep_link, AppLink, DeepLinkRoute, DeepLinkSteps, DeepLinks,
};
use polaris_client::instance::USING_LOCAL_WORDS;
use polaris_client::navigation::{
    back_index, classify_navigation, is_safe_external_url, is_server_url, main_frame_step,
    server_path, starts_provider_trip, MainFrameStep, NavigationVerdict,
};
use polaris_client::permissions::{allow_local_permission, allow_permission};
use polaris_client::window_failover::{
    active_origin, back_step, failed_load_step, same_place_on, title_with, triggers_failover,
    BackStep, FailedLoad,
};
use std::sync::{Arc, Mutex};

const SERVER: &str = "https://polaris.example.com";
const PRIMARY: &str = "https://polaris.example.com";
const LOCAL: &str = "https://polaris.local";

#[test]
fn only_the_configured_polaris_stays_in_the_window() {
    use NavigationVerdict::*;
    for (url, verdict) in [
        ("https://polaris.example.com/home", Allow),
        (
            "https://polaris.example.com/apps/deploy?service=1#logs",
            Allow,
        ),
        ("https://POLARIS.example.com/", Allow),
        ("https://github.com/settings/tokens", External),
        ("http://polaris.example.com/home", External),
        ("https://polaris.example.com:8443/", External),
        ("https://evil.polaris.example.com/", External),
        ("https://polaris.example.com.evil.test/", External),
        ("https://polaris.example.com@evil.test/", External),
        ("mailto:someone@example.com", External),
        ("file:///etc/passwd", Block),
        ("javascript:alert(1)", Block),
        ("data:text/html,hi", Block),
        ("ms-settings:privacy", Block),
        ("not a url", Block),
    ] {
        assert_eq!(classify_navigation(url, SERVER), verdict, "{url}");
    }
    assert!(is_server_url("https://polaris.example.com/x", SERVER));
    assert!(!is_server_url("https://example.com/x", SERVER));
    assert!(is_safe_external_url("https://example.com/x"));
    assert!(!is_safe_external_url("httpevil://example.com"));
    assert!(!is_safe_external_url("file:///etc/passwd"));
}

#[test]
fn a_provider_round_trip_starts_only_on_the_polaris_routes() {
    assert!(starts_provider_trip(
        "https://polaris.example.com/api/connections/google/link",
        SERVER
    ));
    assert!(starts_provider_trip(
        "https://polaris.example.com/api/connections/google/link?scope=mail",
        SERVER
    ));
    assert!(starts_provider_trip(
        "https://polaris.example.com/api/connections/discord/signin?redirect=%2Fdrive",
        SERVER
    ));
    assert!(!starts_provider_trip(
        "https://polaris.example.com/account/connections",
        SERVER
    ));
    assert!(!starts_provider_trip(
        "https://polaris.example.com/api/connections/google/callback",
        SERVER
    ));
    assert!(!starts_provider_trip(
        "https://polaris.example.com/api/connections/google/link/x",
        SERVER
    ));
    assert!(!starts_provider_trip(
        "https://evil.test/api/connections/google/link",
        SERVER
    ));
}

#[test]
fn the_main_frame_may_leave_only_during_a_round_trip() {
    let step = |verdict, trip| MainFrameStep { verdict, trip };
    use NavigationVerdict::*;
    assert_eq!(
        main_frame_step("https://polaris.example.com/home", SERVER, false),
        step(Allow, false)
    );
    assert_eq!(
        main_frame_step("https://accounts.google.com/o", SERVER, false),
        step(External, false)
    );
    assert_eq!(
        main_frame_step("file:///etc/passwd", SERVER, false),
        step(Block, false)
    );
    let start = main_frame_step(
        "https://polaris.example.com/api/connections/google/link",
        SERVER,
        false,
    );
    assert_eq!(start, step(Allow, true));
    let out = main_frame_step("https://accounts.google.com/o", SERVER, start.trip);
    assert_eq!(out, step(Allow, true));
    assert_eq!(
        main_frame_step("javascript:alert(1)", SERVER, true),
        step(Block, true)
    );
    assert_eq!(
        main_frame_step("ms-settings:privacy", SERVER, true),
        step(Block, true)
    );
}

#[test]
fn back_never_lands_outside_the_polaris() {
    let home = format!("{SERVER}/home");
    let drive = format!("{SERVER}/drive");
    assert_eq!(back_index(&[&home, &drive], 1, SERVER), Some(0));
    let history = [
        home.as_str(),
        drive.as_str(),
        "https://accounts.google.com/a",
        "https://accounts.google.com/b",
    ];
    assert_eq!(back_index(&history, 3, SERVER), Some(1));
    assert_eq!(
        back_index(&["https://accounts.google.com/a", &home], 1, SERVER),
        None
    );
    assert_eq!(back_index(&[&home], 0, SERVER), None);
}

#[test]
fn a_page_path_stays_on_the_polaris() {
    assert_eq!(
        server_path("/apps/deploy/p1/logs?service=s1", SERVER).as_deref(),
        Some("https://polaris.example.com/apps/deploy/p1/logs?service=s1")
    );
    for path in [
        "//evil.test/x",
        "/\\evil.test/x",
        "https://evil.test/x",
        "javascript:alert(1)",
        "apps/deploy",
    ] {
        assert_eq!(server_path(path, SERVER), None, "{path}");
    }
}

#[test]
fn permissions_go_only_to_the_configured_polaris() {
    for permission in [
        "notifications",
        "clipboard-read",
        "clipboard-sanitized-write",
        "media",
        "fullscreen",
        "display-capture",
    ] {
        assert!(allow_permission(
            permission,
            "https://polaris.example.com/chat",
            Some(SERVER)
        ));
        assert!(!allow_permission(
            permission,
            "https://evil.test/",
            Some(SERVER)
        ));
    }
    for permission in ["geolocation", "midi", "openExternal", "pointerLock"] {
        assert!(!allow_permission(
            permission,
            "https://polaris.example.com/",
            Some(SERVER)
        ));
    }
    assert!(!allow_permission(
        "notifications",
        "https://polaris.example.com/",
        None
    ));
    assert!(!allow_permission(
        "notifications",
        "not a url",
        Some(SERVER)
    ));
    assert!(allow_local_permission(
        "media",
        Some("connect"),
        Some(&["video"])
    ));
    assert!(allow_local_permission("media", Some("connect"), None));
    assert!(!allow_local_permission(
        "media",
        Some("connect"),
        Some(&["video", "audio"])
    ));
    assert!(!allow_local_permission("media", Some("connect"), Some(&[])));
    assert!(!allow_local_permission(
        "media",
        Some("api-key"),
        Some(&["video"])
    ));
    assert!(!allow_local_permission(
        "notifications",
        Some("connect"),
        None
    ));
}

#[test]
fn only_an_address_that_did_not_answer_fails_over() {
    for code in [
        "ERR_NAME_NOT_RESOLVED",
        "ERR_INTERNET_DISCONNECTED",
        "ERR_CONNECTION_REFUSED",
        "ERR_TIMED_OUT",
    ] {
        assert!(triggers_failover(Some(code)), "{code}");
    }
    for code in [
        "ERR_CERT_AUTHORITY_INVALID",
        "ERR_SSL_PROTOCOL_ERROR",
        "ERR_BLOCKED_BY_CLIENT",
    ] {
        assert!(!triggers_failover(Some(code)), "{code}");
    }
    assert!(!triggers_failover(None));
    let home = format!("{PRIMARY}/home");
    assert_eq!(
        failed_load_step(-3, "ERR_ABORTED", &home, PRIMARY),
        FailedLoad::Ignore
    );
    assert_eq!(
        failed_load_step(
            -105,
            "ERR_NAME_NOT_RESOLVED",
            "https://github.com/login",
            PRIMARY
        ),
        FailedLoad::Ignore
    );
    assert_eq!(
        failed_load_step(-105, "ERR_NAME_NOT_RESOLVED", &home, PRIMARY),
        FailedLoad::Failover
    );
    assert_eq!(
        failed_load_step(-202, "ERR_CERT_AUTHORITY_INVALID", &home, PRIMARY),
        FailedLoad::Error
    );
    assert_eq!(
        failed_load_step(
            -102,
            "net::ERR_CONNECTION_REFUSED (-102)",
            &format!("{LOCAL}/tasks"),
            LOCAL
        ),
        FailedLoad::Failover
    );
}

#[test]
fn the_window_moves_to_the_same_place_and_back() {
    assert_eq!(
        same_place_on(&format!("{PRIMARY}/tasks/board?view=list#t-4"), LOCAL).as_deref(),
        Some("https://polaris.local/tasks/board?view=list#t-4")
    );
    assert_eq!(
        same_place_on(&format!("{LOCAL}/chat"), PRIMARY).as_deref(),
        Some("https://polaris.example.com/chat")
    );
    assert_eq!(same_place_on("not a url", LOCAL), None);
    assert_eq!(same_place_on("file:///etc/passwd", LOCAL), None);
    assert_eq!(
        same_place_on(&format!("{PRIMARY}/home"), "javascript:alert(1)"),
        None
    );
    assert_eq!(active_origin(Some(PRIMARY), None), Some(PRIMARY));
    assert_eq!(active_origin(Some(PRIMARY), Some(LOCAL)), Some(LOCAL));
    assert_eq!(active_origin(None, Some(LOCAL)), None);
    // On the alternate, only the alternate is the Polaris.
    assert_eq!(
        classify_navigation(&format!("{PRIMARY}/home"), LOCAL),
        NavigationVerdict::External
    );
    assert_eq!(
        classify_navigation("http://polaris.local/home", LOCAL),
        NavigationVerdict::External
    );
    assert_eq!(back_step(LOCAL, PRIMARY, false), BackStep::Stay);
    assert_eq!(back_step(PRIMARY, PRIMARY, false), BackStep::Now);
    assert_eq!(back_step(PRIMARY, PRIMARY, true), BackStep::OnBlur);
    assert_eq!(
        title_with("Tasks - Polaris", Some(USING_LOCAL_WORDS)),
        format!("Tasks - Polaris - {USING_LOCAL_WORDS}")
    );
    assert_eq!(title_with("  ", Some(USING_LOCAL_WORDS)), USING_LOCAL_WORDS);
    assert_eq!(title_with("Tasks - Polaris", None), "Tasks - Polaris");
}

fn link(server: &str, path: &str) -> String {
    let mut url = url::Url::parse("polaris://open").unwrap();
    url.query_pairs_mut()
        .append_pair("server", server)
        .append_pair("path", path);
    url.to_string()
}

#[test]
fn a_link_names_a_page_and_nothing_else() {
    assert_eq!(
        read_deep_link(&link("https://polaris.example:8443/x", "/chat?a=1")),
        Some(AppLink {
            server: Some("https://polaris.example:8443".into()),
            path: "/chat?a=1".into()
        })
    );
    assert_eq!(
        read_deep_link("polaris://open?server=https%3A%2F%2Fa.example")
            .unwrap()
            .path,
        "/"
    );
    let long = format!(
        "polaris://open?server=https://a.example&path=/{}",
        "a".repeat(2048)
    );
    for value in [
        link("javascript:alert(1)", "/"),
        link("file:///etc/passwd", "/"),
        link("https://user:pw@a.example", "/"),
        link("https://a.example", "//evil.example"),
        link("https://a.example", "/\\evil.example"),
        link("https://a.example", "chat"),
        "polaris://other?server=https://a.example".to_owned(),
        "https://a.example/".to_owned(),
        long,
    ] {
        assert_eq!(read_deep_link(&value), None, "{value}");
    }
    let argv = [
        "polaris.exe",
        "--flag",
        "polaris://open?server=https%3A%2F%2Fa.example&path=%2Fhome",
    ];
    assert_eq!(
        deep_link_in(&argv),
        Some(AppLink {
            server: Some("https://a.example".into()),
            path: "/home".into()
        })
    );
    assert_eq!(deep_link_in(&["polaris.exe"]), None);
}

#[test]
fn a_link_goes_here_to_a_kept_server_or_to_the_browser() {
    let saved = vec![PRIMARY.to_owned(), LOCAL.to_owned()];
    let to = |server: Option<&str>| AppLink {
        server: server.map(str::to_owned),
        path: "/".into(),
    };
    assert_eq!(
        deep_link_route(&to(None), Some(PRIMARY), &saved),
        DeepLinkRoute::Here
    );
    assert_eq!(
        deep_link_route(&to(Some(PRIMARY)), Some(PRIMARY), &saved),
        DeepLinkRoute::Here
    );
    assert_eq!(
        deep_link_route(&to(Some(LOCAL)), Some(PRIMARY), &saved),
        DeepLinkRoute::Switch
    );
    assert_eq!(
        deep_link_route(&to(Some("https://other.example")), Some(PRIMARY), &saved),
        DeepLinkRoute::Browser
    );
}

#[derive(Clone, Default)]
struct Steps {
    current: Arc<Mutex<Option<String>>>,
    said: Arc<Mutex<Vec<String>>>,
    answer: bool,
}

impl DeepLinkSteps for Steps {
    fn current(&self) -> Option<String> {
        self.current.lock().unwrap().clone()
    }
    fn saved(&self) -> Vec<String> {
        vec![PRIMARY.to_owned(), LOCAL.to_owned()]
    }
    fn show(&self, path: Option<&str>) {
        self.said
            .lock()
            .unwrap()
            .push(format!("show {}", path.unwrap_or("-")));
    }
    async fn confirm_switch(&self, server: &str) -> bool {
        self.said.lock().unwrap().push(format!("ask {server}"));
        self.answer
    }
    async fn switch_to(&self, server: &str) -> bool {
        *self.current.lock().unwrap() = Some(server.to_owned());
        self.said.lock().unwrap().push(format!("switch {server}"));
        true
    }
    fn open_in_browser(&self, url: &str) {
        self.said.lock().unwrap().push(format!("browser {url}"));
    }
}

#[tokio::test]
async fn a_link_waits_for_the_app_and_a_switch_takes_a_yes() {
    let steps = Steps {
        current: Arc::new(Mutex::new(Some(PRIMARY.to_owned()))),
        answer: true,
        ..Steps::default()
    };
    let said = steps.said.clone();
    let first = AppLink {
        server: Some(PRIMARY.into()),
        path: "/first".into(),
    };
    let links = DeepLinks::new(steps, Some(first));
    let newest = AppLink {
        server: Some(PRIMARY.into()),
        path: "/newest".into(),
    };
    assert_eq!(links.arrive(newest.clone()), None);
    assert!(said.lock().unwrap().is_empty());
    let waiting = links.opened().expect("the newest link waited");
    assert_eq!(waiting, newest);
    links.open(waiting).await;
    let other = AppLink {
        server: Some(LOCAL.into()),
        path: "/tasks".into(),
    };
    let now = links.arrive(other).expect("opened: a link opens at once");
    links.open(now).await;
    let stranger = links
        .arrive(AppLink {
            server: Some("https://other.example".into()),
            path: "/x".into(),
        })
        .unwrap();
    links.open(stranger).await;
    assert_eq!(
        *said.lock().unwrap(),
        [
            "show /newest",
            "show -",
            "ask https://polaris.local",
            "switch https://polaris.local",
            "show /tasks",
            "browser https://other.example/x"
        ]
    );
}

#[tokio::test]
async fn a_no_leaves_the_app_where_it_was() {
    let steps = Steps {
        current: Arc::new(Mutex::new(Some(PRIMARY.to_owned()))),
        answer: false,
        ..Steps::default()
    };
    let said = steps.said.clone();
    let links = DeepLinks::new(steps, None);
    assert_eq!(links.opened(), None);
    links
        .open(AppLink {
            server: Some(LOCAL.into()),
            path: "/tasks".into(),
        })
        .await;
    assert_eq!(
        *said.lock().unwrap(),
        ["show -", "ask https://polaris.local"]
    );
}
