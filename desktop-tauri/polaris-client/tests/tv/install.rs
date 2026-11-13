//! Installing on a TV: the checks that decide whether anything may be done to a
//! set, the commands it sends, the release lookup against a recorded GitHub
//! answer, and the steps after the connection against a scripted TV. The same
//! cases as `desktop/test/main/tv-install.test.ts` (its packet, key and session
//! cases are in `tests/adb`). No real TV is touched.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use polaris_client::adb_client::AdbError;
use polaris_client::adb_pairing::{PairingError, PairingFailure};
use polaris_client::tv_install::*;
use polaris_client::tv_path::{choose_path, TvEdition, TvIdentity, TvService, TvSighting};
use polaris_client::tv_wait::{TvWaitResult, TvWaitStep};
use polaris_client::usb_adb::TvUsbDevice;
use serde_json::json;
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn refuses_what_is_not_an_android_tv_and_what_is_too_old() {
    let tv = "feature:android.software.leanback\nfeature:android.hardware.wifi";
    assert_eq!(tv_refusal("30\n", tv), None);
    assert_eq!(tv_refusal("26", tv), None);
    assert_eq!(tv_refusal("25", tv), Some(TvOutcome::TooOld));
    assert_eq!(tv_refusal("", tv), Some(TvOutcome::TooOld));
    assert_eq!(
        tv_refusal("30", "feature:android.hardware.touchscreen"),
        Some(TvOutcome::NotAndroidTv)
    );
}

#[test]
fn confirms_home_instead_of_assuming_it() {
    assert!(home_is_ours(
        "priority=0 preferredOrder=0\napp.polaris.tv/.MainActivity\n"
    ));
    assert!(!home_is_ours("com.google.android.tvlauncher/.MainActivity"));
    assert!(!home_is_ours(
        "com.google.android.tungsten.setupwraith/.RecoveryActivity"
    ));
}

#[test]
fn tells_a_closed_port_from_a_silent_address() {
    let io = |kind| AdbError::Io(std::io::Error::from(kind));
    assert_eq!(
        connect_failure(&io(std::io::ErrorKind::ConnectionRefused)),
        TvOutcome::AdbOff
    );
    assert_eq!(connect_failure(&AdbError::Stopped), TvOutcome::NotAllowed);
    assert_eq!(
        connect_failure(&io(std::io::ErrorKind::HostUnreachable)),
        TvOutcome::Unreachable
    );
    assert_eq!(
        connect_failure(&AdbError::ConnectTimeout),
        TvOutcome::Unreachable
    );
}

#[test]
fn refuses_what_is_not_a_private_address_or_not_the_right_shape() {
    assert!(read_start(&json!({ "host": "8.8.8.8", "home": true })).is_none());
    assert!(read_start(&json!({ "host": "192.168.1.50" })).is_none());
    assert!(read_start(&json!(null)).is_none());
    assert!(read_start(&json!({ "host": 3232235826u32, "home": true })).is_none());
    assert!(read_start(&json!({ "host": "192.168.1.50", "home": true, "extra": 1 })).is_none());
    assert!(read_start(&json!({ "usb": "   ", "home": true })).is_none());
    assert!(read_start(&json!({ "usb": "x".repeat(201), "home": true })).is_none());
    assert!(
        read_start(&json!({ "host": "192.168.1.50", "home": true, "code": "1".repeat(33) }))
            .is_none()
    );
}

#[test]
fn reads_a_pairing_code_only_as_the_tvs_six_digits() {
    for code in ["", "12345", "1234567", "12ab56", "12 34 5"] {
        let request = read_start(&json!({ "host": "192.168.1.50", "home": true, "code": code }));
        // The shape passes; the code itself is what a start refuses.
        assert!(request.is_some());
        assert_eq!(
            polaris_client::adb_pairing::read_pairing_code(code),
            None,
            "{code}"
        );
    }
}

#[test]
fn says_a_wrong_code_apart_from_a_tv_that_could_not_be_reached_and_keeps_a_cancel_quiet() {
    let failed = |reason| pairing_failure(&PairingError::new(reason, "x"));
    assert_eq!(
        failed(PairingFailure::WrongCode),
        Some(TvOutcome::PairingRefused)
    );
    assert_eq!(failed(PairingFailure::Cancelled), None);
    for reason in [
        PairingFailure::Timeout,
        PairingFailure::Unreachable,
        PairingFailure::Protocol,
    ] {
        assert_eq!(failed(reason), Some(TvOutcome::Unreachable));
    }
}

#[test]
fn names_the_steps_it_took_its_menus_from_so_the_dashboard_can_read_them_in_its_own_language() {
    let path = choose_path(
        &TvSighting {
            services: vec![TvService::AdbTlsPairing],
            ..TvSighting::default()
        },
        None,
    );
    let waiting = waiting_for(TvWaitStep::Debugging, &path);
    assert_eq!(waiting.steps, path.instruction.id);
    assert_eq!(waiting.step, TvWaitStep::Debugging);
    assert_eq!(waiting.about, path.instruction.about);
    assert_eq!(waiting.switches, path.instruction.switches);
}

#[test]
fn a_wait_that_ended_says_what_to_do() {
    assert_eq!(
        wait_outcome::<()>(&TvWaitResult::Timeout(TvWaitStep::Prompt)),
        Some(TvOutcome::NotAllowed)
    );
    assert_eq!(
        wait_outcome::<()>(&TvWaitResult::Timeout(TvWaitStep::Debugging)),
        Some(TvOutcome::AdbOff)
    );
    assert_eq!(
        wait_outcome::<()>(&TvWaitResult::Failed("usb-busy".into())),
        Some(TvOutcome::UsbBusy)
    );
    assert_eq!(wait_outcome::<()>(&TvWaitResult::Cancelled), None);
}

#[test]
fn says_how_far_it_got() {
    assert_eq!(late_failure(TvStage::Check), TvOutcome::ConnectionLost);
    assert_eq!(late_failure(TvStage::Backup), TvOutcome::BackupFailed);
    assert_eq!(late_failure(TvStage::Send), TvOutcome::ConnectionLost);
    assert_eq!(
        late_failure(TvStage::Install),
        TvOutcome::InstallInterrupted
    );
    assert_eq!(late_failure(TvStage::Home), TvOutcome::InstalledHomeUnknown);
}

#[test]
fn opens_the_shell_only_alias_with_this_apps_polaris_as_a_bare_origin() {
    assert_eq!(
        link_command(Some("https://polaris.example.com/home?x=1")).as_deref(),
        Some("am start -n app.polaris.tv/.LinkFromInstall --es origin https://polaris.example.com")
    );
    assert_eq!(
        link_command(Some("http://192.168.1.20:3000")).as_deref(),
        Some("am start -n app.polaris.tv/.LinkFromInstall --es origin http://192.168.1.20:3000")
    );
}

#[test]
fn does_nothing_without_a_polaris_or_with_an_address_that_is_not_plain_http() {
    assert_eq!(link_command(None), None);
    assert_eq!(link_command(Some("not a url")), None);
    assert_eq!(link_command(Some("file:///etc/passwd")), None);
    assert_eq!(link_command(Some("javascript:alert(1)")), None);
}

#[test]
fn does_nothing_when_the_address_is_this_computers_own_loopback() {
    for address in [
        "http://localhost:3000",
        "http://app.localhost",
        "http://127.0.0.1:3000",
        "http://127.1.2.3",
        "http://[::1]:3000",
        "http://0.0.0.0",
        "http://[::ffff:127.0.0.1]",
    ] {
        assert_eq!(link_command(Some(address)), None, "{address}");
    }
}

#[test]
fn leaves_a_tv_that_is_already_linked_alone() {
    assert_eq!(
        LINK_STATE_READ,
        "am broadcast -f 32 -n app.polaris.tv/.LinkState"
    );
    assert!(already_linked("Broadcasting: Intent { flg=0x20 cmp=app.polaris.tv/.LinkState }\nBroadcast completed: result=0, data=\"linked=true\"\n"));
    assert!(!already_linked(
        "Broadcast completed: result=0, data=\"linked=false\"\n"
    ));
    assert!(!already_linked("Broadcast completed: result=0\n"));
    assert!(!already_linked(""));
}

#[test]
fn tells_a_started_activity_from_ams_errors() {
    assert!(opened(
        "Starting: Intent { cmp=app.polaris.tv/.LinkFromInstall (has extras) }\n"
    ));
    assert!(!opened("Error type 3\nError: Activity class {app.polaris.tv/app.polaris.tv.LinkFromInstall} does not exist."));
    assert!(!opened("java.lang.SecurityException: Permission Denial"));
    assert!(!opened(""));
}

#[test]
fn grants_location_always_and_secure_settings_only_when_ad_blocking_was_asked_for() {
    assert_eq!(
        grant_commands(false),
        vec!["pm grant app.polaris.tv android.permission.ACCESS_FINE_LOCATION"]
    );
    assert_eq!(
        grant_commands(true),
        vec![
            "pm grant app.polaris.tv android.permission.ACCESS_FINE_LOCATION",
            "pm grant app.polaris.tv android.permission.WRITE_SECURE_SETTINGS"
        ]
    );
    for command in grant_commands(true) {
        assert!(!command.contains("revoke") && !command.contains("settings put"));
    }
}

#[test]
fn backs_up_the_private_dns_mode_and_hostname_by_name_and_only_reads_them() {
    assert!(PRIVATE_DNS_READ.contains("private_dns_mode=$(settings get global private_dns_mode)"));
    assert!(PRIVATE_DNS_READ
        .contains("private_dns_specifier=$(settings get global private_dns_specifier)"));
    assert!(
        !PRIVATE_DNS_READ.contains("settings put") && !PRIVATE_DNS_READ.contains("settings delete")
    );
    for (_, command) in BACKUP_READS {
        assert!(!command.contains("settings put") && !command.contains(" rm "));
    }
}

#[test]
fn stamps_a_backup_folder_as_the_electron_app_names_it() {
    let at = UNIX_EPOCH + Duration::from_millis(1_763_034_450_123);
    assert_eq!(backup_stamp(at), "2025-11-13T11-47-30-123Z");
    assert_eq!(backup_stamp(UNIX_EPOCH), "1970-01-01T00-00-00-000Z");
}

#[test]
fn reads_the_release_list_of_the_repository() {
    assert_eq!(
        release_api(REPOSITORY).as_deref(),
        Some("https://api.github.com/repos/FJRG2007/polaris/releases?per_page=100")
    );
    assert_eq!(
        release_api("git+https://github.com/a/b.git").as_deref(),
        Some("https://api.github.com/repos/a/b/releases?per_page=100")
    );
    assert_eq!(release_api("https://example.com/a/b"), None);
}

#[test]
fn reads_checksums_and_keeps_neither_of_a_name_listed_twice() {
    let a = "a".repeat(64);
    let b = "B".repeat(64);
    let sums = parse_checksums(&format!(
        "{a}  one.apk\n{b} *two.apk\nnot a line\n{a}  dup\n{b}  dup\n"
    ));
    assert_eq!(sums.get("one.apk"), Some(&a));
    assert_eq!(sums.get("two.apk"), Some(&"b".repeat(64)));
    assert!(!sums.contains_key("dup"));
}

mod release {
    use super::*;

    fn other(at: usize) -> serde_json::Value {
        json!({ "tag_name": format!("desktop-v0.0.{at}"), "draft": false, "prerelease": false, "assets": [] })
    }

    fn tv(base: &str, extra: Option<serde_json::Value>) -> serde_json::Value {
        let mut assets = vec![
            json!({ "name": "polaris-tv.apk", "browser_download_url": format!("{base}/apk") }),
            json!({ "name": "SHA256SUMS", "browser_download_url": format!("{base}/sums") }),
        ];
        assets.extend(extra);
        json!({ "tag_name": "tv-v1.2.3", "draft": false, "prerelease": false, "assets": assets, "html_url": "ignored" })
    }

    fn digest() -> String {
        Sha256::digest(b"apk")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    async fn serve(pages: Vec<serde_json::Value>, sums: String) -> MockServer {
        let server = MockServer::start().await;
        for (at, page) in pages.into_iter().enumerate() {
            Mock::given(method("GET"))
                .and(path("/releases"))
                .and(query_param("page", (at + 1).to_string()))
                .respond_with(ResponseTemplate::new(200).set_body_json(page))
                .mount(&server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/sums"))
            .respond_with(ResponseTemplate::new(200).set_body_string(sums))
            .mount(&server)
            .await;
        for at in ["/apk", "/home-key/apk"] {
            Mock::given(method("GET"))
                .and(path(at))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(b"apk".to_vec()))
                .mount(&server)
                .await;
        }
        server
    }

    fn api(server: &MockServer) -> String {
        format!("{}/releases?per_page=100", server.uri())
    }

    async fn asked(server: &MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .map(|one| one.url.to_string())
            .collect()
    }

    #[tokio::test]
    async fn walks_past_a_full_page_of_other_releases() {
        let first: Vec<_> = (0..100).map(other).collect();
        let server = MockServer::start().await;
        let base = server.uri();
        drop(server);
        let server = serve(
            vec![json!(first), json!([tv(&base, None)])],
            format!("{}  polaris-tv.apk\n", digest()),
        )
        .await;
        // The asset links name the first server's address; point them at this one.
        let list: Vec<PublishedRelease> = vec![];
        drop(list);
        let http = release_client().unwrap();
        let release = newest_release(&http, &api(&server)).await.unwrap().unwrap();
        assert_eq!(release.tag_name, "tv-v1.2.3");
        let pages = asked(&server).await;
        assert_eq!(pages.iter().filter(|url| url.contains("page=2")).count(), 1);
    }

    #[tokio::test]
    async fn stops_at_a_page_that_is_not_full_and_reports_nothing_released() {
        let server = serve(vec![json!([other(1)])], String::new()).await;
        let http = release_client().unwrap();
        let found = latest_apk(&http, &api(&server), TvEdition::Standard)
            .await
            .unwrap();
        assert_eq!(found, None);
        assert_eq!(asked(&server).await.len(), 1);
    }

    async fn served_tv(
        extra: Option<serde_json::Value>,
        sums: impl Fn(&str) -> String,
    ) -> MockServer {
        // The release names its files on the server that lists it.
        let server = MockServer::start().await;
        let base = server.uri();
        let extra = extra.map(|value| {
            let text = value.to_string().replace("BASE", &base);
            serde_json::from_str(&text).unwrap()
        });
        Mock::given(method("GET"))
            .and(path("/releases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([tv(&base, extra)])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sums"))
            .respond_with(ResponseTemplate::new(200).set_body_string(sums(&digest())))
            .mount(&server)
            .await;
        for at in ["/apk", "/home-key/apk"] {
            Mock::given(method("GET"))
                .and(path(at))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(b"apk".to_vec()))
                .mount(&server)
                .await;
        }
        server
    }

    #[tokio::test]
    async fn fetches_and_verifies_the_apk() {
        let server = served_tv(None, |digest| format!("{digest}  polaris-tv.apk\n")).await;
        let http = release_client().unwrap();
        let fetched = latest_apk(&http, &api(&server), TvEdition::Standard)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched.version, "1.2.3");
        assert_eq!(fetched.apk, b"apk");
    }

    #[tokio::test]
    async fn refuses_an_apk_that_does_not_match_its_checksum() {
        let server = served_tv(None, |_| format!("{}  polaris-tv.apk\n", "0".repeat(64))).await;
        let http = release_client().unwrap();
        assert!(latest_apk(&http, &api(&server), TvEdition::Standard)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn fetches_the_home_key_edition_from_its_own_asset_and_checksum_line() {
        let edition = json!({ "name": "polaris-tv-home-key.apk", "browser_download_url": "BASE/home-key/apk" });
        let server = served_tv(Some(edition), |digest| {
            format!(
                "{}  polaris-tv.apk\n{digest}  polaris-tv-home-key.apk\n",
                "0".repeat(64)
            )
        })
        .await;
        assert_eq!(apk_name_of(TvEdition::HomeKey), "polaris-tv-home-key.apk");
        let http = release_client().unwrap();
        let fetched = latest_apk(&http, &api(&server), TvEdition::HomeKey)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched.version, "1.2.3");
        assert!(asked(&server)
            .await
            .iter()
            .any(|url| url.ends_with("/home-key/apk")));
    }

    #[tokio::test]
    async fn reports_the_home_key_edition_unreleased_when_the_newest_release_lacks_it() {
        let server = served_tv(None, |digest| format!("{digest}  polaris-tv.apk\n")).await;
        let http = release_client().unwrap();
        assert_eq!(
            latest_apk(&http, &api(&server), TvEdition::HomeKey)
                .await
                .unwrap(),
            None
        );
    }
}

#[test]
fn reads_null_and_empty_as_no_services_and_refuses_an_answer_that_is_not_a_list() {
    assert_eq!(accessibility_entries("null\n"), Some(vec![]));
    assert_eq!(accessibility_entries("  \n"), Some(vec![]));
    assert_eq!(
        accessibility_entries("com.a/.One:com.b/com.b.Two$Inner\n"),
        Some(vec![
            "com.a/.One".to_string(),
            "com.b/com.b.Two$Inner".to_string()
        ])
    );
    assert_eq!(
        accessibility_entries("cmd: Can't find service: settings"),
        None
    );
}

const SERVICE: &str = "app.polaris.tv/.HomeKeyService";

#[test]
fn puts_the_service_after_what_is_there_never_in_its_place() {
    assert_eq!(
        home_key_commands(&[]),
        vec![
            format!("settings put secure enabled_accessibility_services '{SERVICE}'"),
            "settings put secure accessibility_enabled 1".to_string()
        ]
    );
    assert_eq!(
        home_key_commands(&["com.a/.One".into(), "com.b/.Two$X".into()])[0],
        format!("settings put secure enabled_accessibility_services 'com.a/.One:com.b/.Two$X:{SERVICE}'")
    );
}

#[test]
fn clears_and_writes_back_a_list_that_already_has_it_so_the_service_binds_again() {
    let commands = home_key_commands(&[
        "com.a/.One".into(),
        "app.polaris.tv/app.polaris.tv.HomeKeyService".into(),
    ]);
    let list = "'com.a/.One:app.polaris.tv/app.polaris.tv.HomeKeyService'";
    assert_eq!(commands[0], format!("settings put secure enabled_accessibility_services ''; settings put secure accessibility_enabled 0; sleep 1; settings put secure enabled_accessibility_services {list}"));
    assert_eq!(commands[1], "settings put secure accessibility_enabled 1");
}

#[test]
fn counts_it_on_only_when_listed_and_accessibility_is_on() {
    assert!(home_key_on(&format!("com.a/.One:{SERVICE}\n1\n")));
    assert!(home_key_on(
        "app.polaris.tv/app.polaris.tv.HomeKeyService\r\n1\r\n"
    ));
    assert!(!home_key_on(&format!("{SERVICE}\n0\n")));
    assert!(!home_key_on("com.a/.One\n1\n"));
    assert!(!home_key_on("null\nnull\n"));
}

#[test]
fn takes_the_mode_when_the_page_sends_it_and_reads_home_alone_the_way_pages_before_it_meant_it() {
    assert_eq!(
        install_mode(Some(TvInstallMode::App), Some(true)),
        TvInstallMode::App
    );
    assert_eq!(
        install_mode(Some(TvInstallMode::System), None),
        TvInstallMode::System
    );
    assert_eq!(install_mode(None, Some(true)), TvInstallMode::System);
    assert_eq!(install_mode(None, Some(false)), TvInstallMode::App);
}

#[test]
fn accepts_a_page_that_sends_only_home_only_mode_or_both_and_refuses_one_that_sends_neither() {
    let host = "192.168.1.50";
    assert!(read_start(&json!({ "host": host, "home": false })).is_some());
    assert!(read_start(&json!({ "host": host, "mode": "app" })).is_some());
    assert!(read_start(&json!({ "usb": "abc", "mode": "system", "home": true })).is_some());
    assert!(read_start(&json!({ "host": host })).is_none());
    assert!(read_start(&json!({ "usb": "abc" })).is_none());
    assert!(read_start(&json!({ "host": host, "mode": "root" })).is_none());
    let read =
        read_start(&json!({ "host": " 192.168.1.50 ", "mode": "app", "blockAds": true })).unwrap();
    assert_eq!(
        read.target,
        StartWhere::Network {
            host: host.into(),
            code: None
        }
    );
    assert!(read.block_ads);
}

#[test]
fn installs_only_on_a_usb_tv_that_was_listed() {
    let listed = vec![TvUsbDevice {
        id: "s:ABC123".into(),
        name: "TV".into(),
    }];
    let usb = |id: &str| read_start(&json!({ "usb": id, "home": true })).unwrap();
    assert_eq!(
        start_target(&usb("s:ABC123"), Some(&listed)),
        Some(TvTarget::Usb {
            id: "s:ABC123".into()
        })
    );
    assert_eq!(start_target(&usb("s:OTHER"), Some(&listed)), None);
    assert_eq!(start_target(&usb("s:ABC123"), None), None);
    let network = read_start(&json!({ "host": "192.168.1.5", "home": false })).unwrap();
    assert_eq!(
        start_target(&network, None),
        Some(TvTarget::Network {
            host: "192.168.1.5".into()
        })
    );
}

const LISTENER: &str = "app.polaris.tv/.GuardRevival";

fn grant(rung: TvControlRung, sdk: Option<u32>) -> TvControlGrant {
    control_grants(sdk)
        .into_iter()
        .find(|one| one.rung == rung)
        .unwrap()
}

#[test]
fn tries_the_levels_strongest_first_and_only_what_the_launcher_declares() {
    let rungs: Vec<_> = control_grants(Some(30))
        .iter()
        .map(|one| one.rung)
        .collect();
    assert_eq!(
        rungs,
        vec![
            TvControlRung::SecureSettings,
            TvControlRung::NotificationListener,
            TvControlRung::InstallPackages,
            TvControlRung::Battery
        ]
    );
    let run = |rung| (grant(rung, Some(30)).commands)("");
    assert_eq!(
        run(TvControlRung::SecureSettings),
        Some(vec![
            "pm grant app.polaris.tv android.permission.WRITE_SECURE_SETTINGS".to_string()
        ])
    );
    assert_eq!(
        run(TvControlRung::InstallPackages),
        Some(vec![
            "appops set app.polaris.tv REQUEST_INSTALL_PACKAGES allow".to_string()
        ])
    );
    assert_eq!(
        run(TvControlRung::Battery),
        Some(vec![
            "dumpsys deviceidle whitelist +app.polaris.tv".to_string()
        ])
    );
    let all: Vec<String> = control_grants(Some(30))
        .iter()
        .chain(control_grants(Some(23)).iter())
        .flat_map(|one| (one.commands)("null").unwrap_or_default())
        .collect();
    let all = all.join("\n");
    assert!(!all.contains("GET_USAGE_STATS") && !all.contains("SYSTEM_ALERT_WINDOW"));
}

#[test]
fn puts_the_listener_after_what_is_there_never_in_its_place() {
    let put = |list: &str| {
        vec![format!(
            "settings put secure enabled_notification_listeners '{list}'"
        )]
    };
    assert_eq!(listener_commands("null\n"), Some(put(LISTENER)));
    assert_eq!(listener_commands(""), Some(put(LISTENER)));
    assert_eq!(
        listener_commands("com.a/com.a.Listen:com.b/.Other$X\n"),
        Some(put(&format!(
            "com.a/com.a.Listen:com.b/.Other$X:{LISTENER}"
        )))
    );
    let old = grant(TvControlRung::NotificationListener, Some(23));
    assert_eq!(
        old.before.as_deref(),
        Some("settings get secure enabled_notification_listeners")
    );
    assert_eq!((old.commands)("null"), Some(put(LISTENER)));
}

#[test]
fn asks_the_notification_service_from_android_8_on_and_believes_only_what_it_reports() {
    for sdk in [Some(26), Some(30), None] {
        let listen = grant(TvControlRung::NotificationListener, sdk);
        assert_eq!(listen.before, None);
        assert_eq!(
            (listen.commands)(""),
            Some(vec![format!("cmd notification allow_listener {LISTENER}")])
        );
        assert_eq!(listen.check, "dumpsys notification | grep -F GuardRevival");
    }
    assert!(listener_enabled(
        "      ComponentInfo{app.polaris.tv/app.polaris.tv.GuardRevival}\n"
    ));
    assert!(listener_enabled("    ManagedServiceInfo[component=ComponentInfo{app.polaris.tv/app.polaris.tv.GuardRevival},userid=0]\n"));
    assert!(!listener_enabled(
        "      app.polaris.tv/app.polaris.tv.GuardRevival\n"
    ));
    assert!(!listener_enabled(""));
}

#[test]
fn writes_nothing_when_it_is_listed_already_in_either_spelling_or_when_the_list_is_not_a_list() {
    assert_eq!(
        listener_commands(&format!("com.a/.One:{LISTENER}")),
        Some(vec![])
    );
    assert_eq!(
        listener_commands("app.polaris.tv/app.polaris.tv.GuardRevival"),
        Some(vec![])
    );
    assert_eq!(listener_commands("cmd: Can't find service: settings"), None);
    assert_eq!(listener_commands("com.a/.One:not a component"), None);
}

#[test]
fn counts_each_level_only_when_the_read_back_shows_it() {
    assert!(secure_settings_granted(
        "      android.permission.WRITE_SECURE_SETTINGS: granted=true\n"
    ));
    assert!(!secure_settings_granted(
        "      android.permission.WRITE_SECURE_SETTINGS: granted=false\n"
    ));
    assert!(!secure_settings_granted(""));
    let old = grant(TvControlRung::NotificationListener, Some(23));
    assert!((old.got)(&format!("com.a/.One:{LISTENER}\n")));
    assert!(!(old.got)("null\n"));
    assert!(install_packages_allowed(
        "REQUEST_INSTALL_PACKAGES: allow; time=+2m ago\n"
    ));
    assert!(install_packages_allowed(
        "REQUEST_INSTALL_PACKAGES: allow\n"
    ));
    assert!(!install_packages_allowed(
        "REQUEST_INSTALL_PACKAGES: default\n"
    ));
    assert!(!install_packages_allowed("No operations.\n"));
    assert!(battery_whitelisted(
        "system-excidle,com.example.one,1000\r\nuser,app.polaris.tv,10123\r\n"
    ));
    assert!(!battery_whitelisted("user,app.polaris.tv.other,10124\n"));
    assert!(!battery_whitelisted(""));
}

/// A connected TV that answers from a script and records what it was asked.
#[derive(Default)]
struct ScriptedTv {
    answers: HashMap<String, String>,
    /// Commands that fail as if the TV refused them.
    refuse: Vec<String>,
    ran: Vec<String>,
    pushed: Vec<(String, usize)>,
    closed: bool,
}

impl ScriptedTv {
    fn answer(mut self, command: &str, answer: &str) -> Self {
        self.answers.insert(command.to_owned(), answer.to_owned());
        self
    }
}

impl TvAdb for ScriptedTv {
    async fn shell(&mut self, command: &str) -> Result<String, AdbError> {
        self.ran.push(command.to_owned());
        if self.closed {
            return Err(AdbError::Closed);
        }
        if self
            .refuse
            .iter()
            .any(|one| command.starts_with(one.as_str()))
        {
            return Err(AdbError::Refused);
        }
        Ok(self.answers.get(command).cloned().unwrap_or_default())
    }

    async fn shell_within(
        &mut self,
        command: &str,
        _timeout: Duration,
    ) -> Result<String, AdbError> {
        self.shell(command).await
    }

    async fn push(&mut self, path: &str, data: &[u8]) -> Result<(), AdbError> {
        self.ran.push(format!("push {path}"));
        self.pushed.push((path.to_owned(), data.len()));
        Ok(())
    }

    async fn close(&mut self) {
        self.closed = true;
    }
}

#[tokio::test]
async fn tries_every_level_even_when_one_throws_or_is_refused_and_reads_before_only_where_it_is_set(
) {
    let mut tv = ScriptedTv::default()
        .answer(
            "dumpsys package app.polaris.tv | grep -F WRITE_SECURE_SETTINGS",
            "android.permission.WRITE_SECURE_SETTINGS: granted=true\n",
        )
        .answer("dumpsys notification | grep -F GuardRevival", "")
        .answer(
            "appops get app.polaris.tv REQUEST_INSTALL_PACKAGES",
            "REQUEST_INSTALL_PACKAGES: allow\n",
        )
        .answer(
            "dumpsys deviceidle whitelist",
            "user,app.polaris.tv,10123\n",
        );
    tv.refuse.push("appops set".into());
    let state = |rung, state| TvControl { rung, state };
    assert_eq!(
        grant_control(&mut tv, &control_grants(Some(30))).await,
        vec![
            state(TvControlRung::SecureSettings, TvControlState::Got),
            state(TvControlRung::NotificationListener, TvControlState::Refused),
            state(TvControlRung::InstallPackages, TvControlState::Refused),
            state(TvControlRung::Battery, TvControlState::Got),
        ]
    );
    assert!(!tv
        .ran
        .contains(&"settings get secure enabled_notification_listeners".to_string()));
    assert!(!tv
        .ran
        .contains(&"appops get app.polaris.tv REQUEST_INSTALL_PACKAGES".to_string()));
    assert!(tv
        .ran
        .contains(&"dumpsys deviceidle whitelist +app.polaris.tv".to_string()));
    tv.ran.clear();
    tv.answers.insert(
        "settings get secure enabled_notification_listeners".into(),
        "cmd: Can't find service: settings".into(),
    );
    assert_eq!(
        grant_control(
            &mut tv,
            &[grant(TvControlRung::NotificationListener, Some(23))]
        )
        .await,
        vec![state(
            TvControlRung::NotificationListener,
            TvControlState::Refused
        )]
    );
    assert_eq!(
        tv.ran,
        vec![
            "settings get secure enabled_notification_listeners",
            "settings get secure enabled_notification_listeners"
        ]
    );
}

#[test]
fn reports_home_as_skipped_where_the_tv_keeps_its_own_and_as_got_only_when_it_was_confirmed() {
    let home = |state| TvControl {
        rung: TvControlRung::Home,
        state,
    };
    assert_eq!(
        home_control(false, TvOutcome::Installed),
        home(TvControlState::Skipped)
    );
    assert_eq!(
        home_control(true, TvOutcome::InstalledHome),
        home(TvControlState::Got)
    );
    assert_eq!(
        home_control(true, TvOutcome::InstalledHomeKey),
        home(TvControlState::Got)
    );
    assert_eq!(
        home_control(true, TvOutcome::InstalledHomeRefused),
        home(TvControlState::Refused)
    );
    assert_eq!(
        home_control(true, TvOutcome::InstalledHomeKeyOff),
        home(TvControlState::Refused)
    );
}

/// The app around the steps: records every state it is told, keeps the backup in a test folder.
struct Around {
    state: Mutex<TvInstallState>,
    phases: Mutex<Vec<TvPhase>>,
    folder: PathBuf,
    apk: Option<FetchedApk>,
}

impl Around {
    fn new(name: &str) -> Self {
        let folder = std::env::temp_dir()
            .join("polaris-client-tests")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        Self {
            state: Mutex::new(TvInstallState::default()),
            phases: Mutex::new(Vec::new()),
            folder,
            apk: Some(FetchedApk {
                apk: vec![1; 5000],
                version: "1.2.3".into(),
            }),
        }
    }
}

impl TvSteps for Around {
    fn publish(&self, change: &dyn Fn(&mut TvInstallState)) {
        let mut state = self.state.lock().unwrap();
        change(&mut state);
        let mut phases = self.phases.lock().unwrap();
        if phases.last() != Some(&state.phase) {
            phases.push(state.phase);
        }
    }

    async fn fetch_apk(&self, _edition: TvEdition) -> Result<Option<FetchedApk>, DownloadFailed> {
        Ok(self.apk.clone())
    }

    fn backup_folder(&self, target: &TvTarget) -> Option<PathBuf> {
        Some(self.folder.join(target_label(target)))
    }

    fn server(&self) -> Option<String> {
        Some("http://192.168.1.20:3000".into())
    }

    async fn closed(&self, _target: &TvTarget) -> bool {
        true
    }
}

const RESOLVE: &str = "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME";
const DEBUGGING_OFF: &str =
    "settings put global adb_wifi_enabled 0; settings put global adb_enabled 0";

fn android_tv() -> ScriptedTv {
    ScriptedTv::default()
        .answer("getprop ro.build.version.sdk", "30\n")
        .answer("pm list features", "feature:android.software.leanback\n")
        .answer("getprop ro.product.manufacturer", "Fakemaker\n")
        .answer("getprop ro.product.model", "Fake TV 1\n")
        .answer("pm install -r /data/local/tmp/polaris-tv.apk", "Success\n")
        .answer(RESOLVE, "priority=0\napp.polaris.tv/.MainActivity\n")
        .answer(
            "am start -n app.polaris.tv/.LinkFromInstall --es origin http://192.168.1.20:3000",
            "Starting: Intent { cmp=app.polaris.tv/.LinkFromInstall }\n",
        )
}

fn target() -> TvTarget {
    TvTarget::Network {
        host: "192.168.1.50".into(),
    }
}

#[tokio::test]
async fn backs_up_before_the_first_change_installs_makes_home_and_switches_debugging_off() {
    let mut tv = android_tv();
    let around = Around::new("full");
    let sighting = TvSighting {
        adb_open: true,
        ..TvSighting::default()
    };
    let identity = TvIdentity {
        manufacturer: "Fakemaker\n".into(),
        model: "Fake TV 1\n".into(),
        sdk: Some(30),
        home_guard: Some(false),
    };
    let path = choose_path(&sighting, Some(&identity));
    install_steps(
        &mut tv,
        &around,
        &target(),
        &sighting,
        TvInstallMode::System,
        false,
    )
    .await;

    let state = around.state.lock().unwrap().clone();
    let first_backup = tv
        .ran
        .iter()
        .position(|one| one == "pm list packages")
        .unwrap();
    let push = tv
        .ran
        .iter()
        .position(|one| one.starts_with("push "))
        .unwrap();
    assert!(
        first_backup < push,
        "the backup comes before the first change"
    );
    let folder = PathBuf::from(state.backup.clone().unwrap());
    for (name, _) in BACKUP_READS {
        assert!(folder.join(name).is_file(), "{name}");
    }
    assert_eq!(
        tv.pushed,
        vec![("/data/local/tmp/polaris-tv.apk".to_string(), 5000)]
    );
    assert!(tv
        .ran
        .contains(&"rm -f /data/local/tmp/polaris-tv.apk".to_string()));
    assert!(tv
        .ran
        .contains(&"pm grant app.polaris.tv android.permission.ACCESS_FINE_LOCATION".to_string()));
    assert_eq!(state.home, Some(path.home));
    let expected = if path.home == polaris_client::tv_path::TvHomeRule::Offered {
        TvOutcome::InstalledHome
    } else {
        TvOutcome::Installed
    };
    assert_eq!(state.outcome, Some(expected));
    assert_eq!(state.phase, TvPhase::Done);
    assert_eq!(state.closed, Some(true));
    assert_eq!(state.linking, Some(true));
    let control = state.control.unwrap();
    assert_eq!(control.len(), 5);
    assert_eq!(control[0].rung, TvControlRung::Home);
    // Nothing uninstalled or disabled; debugging off is the last thing asked.
    assert!(!tv
        .ran
        .iter()
        .any(|one| one.contains("pm uninstall") || one.contains("pm disable")));
    assert_eq!(tv.ran.last().map(String::as_str), Some(DEBUGGING_OFF));
    assert!(tv.closed);
    let phases = around.phases.lock().unwrap().clone();
    assert_eq!(phases.first(), Some(&TvPhase::Checking));
    assert!(phases.contains(&TvPhase::Backup));
    assert_eq!(phases.last(), Some(&TvPhase::Done));
    let _ = std::fs::remove_dir_all(&around.folder);
}

#[tokio::test]
async fn an_app_only_install_changes_nothing_else() {
    let mut tv = android_tv();
    let around = Around::new("app");
    install_steps(
        &mut tv,
        &around,
        &target(),
        &TvSighting::default(),
        TvInstallMode::App,
        false,
    )
    .await;
    let state = around.state.lock().unwrap().clone();
    assert_eq!(state.outcome, Some(TvOutcome::Installed));
    assert_eq!(state.control, Some(vec![]));
    assert!(!tv
        .ran
        .iter()
        .any(|one| one.contains("set-home-activity") || one.contains("appops set")));
    let _ = std::fs::remove_dir_all(&around.folder);
}

#[tokio::test]
async fn refuses_a_set_that_is_not_an_android_tv_before_any_backup_and_still_switches_debugging_off(
) {
    let mut tv = android_tv().answer("pm list features", "feature:android.hardware.touchscreen\n");
    let around = Around::new("refused");
    install_steps(
        &mut tv,
        &around,
        &target(),
        &TvSighting::default(),
        TvInstallMode::System,
        false,
    )
    .await;
    let state = around.state.lock().unwrap().clone();
    assert_eq!(state.outcome, Some(TvOutcome::NotAndroidTv));
    assert_eq!(state.phase, TvPhase::Failed);
    assert_eq!(state.backup, None);
    assert!(tv.pushed.is_empty());
    assert_eq!(tv.ran.last().map(String::as_str), Some(DEBUGGING_OFF));
}

#[tokio::test]
async fn tells_a_sideload_refusal_from_another_failed_install() {
    for (answer, outcome) in [
        (
            "Failure [INSTALL_FAILED_VERIFICATION_FAILURE]",
            TvOutcome::SideloadRefused,
        ),
        (
            "Failure [INSTALL_FAILED_OLDER_SDK]",
            TvOutcome::InstallFailed,
        ),
    ] {
        let mut tv = android_tv().answer("pm install -r /data/local/tmp/polaris-tv.apk", answer);
        let around = Around::new("failed");
        install_steps(
            &mut tv,
            &around,
            &target(),
            &TvSighting::default(),
            TvInstallMode::System,
            false,
        )
        .await;
        assert_eq!(around.state.lock().unwrap().outcome, Some(outcome));
        let _ = std::fs::remove_dir_all(&around.folder);
    }
}

#[tokio::test]
async fn says_nothing_released_when_the_tvs_edition_is_not_published() {
    let mut tv = android_tv();
    let mut around = Around::new("unreleased");
    around.apk = None;
    install_steps(
        &mut tv,
        &around,
        &target(),
        &TvSighting::default(),
        TvInstallMode::System,
        false,
    )
    .await;
    assert_eq!(
        around.state.lock().unwrap().outcome,
        Some(TvOutcome::NotReleased)
    );
    assert!(tv.pushed.is_empty());
}

#[tokio::test]
async fn a_connection_lost_during_the_backup_says_the_backup_failed() {
    let mut tv = ScriptedTv {
        refuse: vec!["settings list".into()],
        ..android_tv()
    };
    let around = Around::new("backup");
    install_steps(
        &mut tv,
        &around,
        &target(),
        &TvSighting::default(),
        TvInstallMode::System,
        false,
    )
    .await;
    assert_eq!(
        around.state.lock().unwrap().outcome,
        Some(TvOutcome::BackupFailed)
    );
    assert!(tv.pushed.is_empty());
    let _ = std::fs::remove_dir_all(&around.folder);
}

#[test]
fn shows_the_state_with_the_names_the_dashboard_reads() {
    let state = TvInstallState {
        usb_listing: true,
        outcome: Some(TvOutcome::InstalledHomeKeyOff),
        ..TvInstallState::default()
    };
    let shown = serde_json::to_value(&state).unwrap();
    assert_eq!(shown["phase"], "ready");
    assert_eq!(shown["usbListing"], true);
    assert_eq!(shown["outcome"], "installed-home-key-off");
    assert_eq!(shown["usb"], serde_json::Value::Null);
    assert_eq!(shown["named"], json!({}));
}
