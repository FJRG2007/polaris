//! Ported from `desktop/test/main/vpn-helper-client.test.ts`, with the service
//! side of `vpn.ts` driven against a stand-in for `desktop/vpn-helper` that
//! reads and writes the same lines its `server.rs` and `auth.rs` do. Nothing is
//! installed and nothing is elevated: the installer is a fake too.

mod service;

use polaris_client::vpn::{join_network, read_secret, Vpn};
use polaris_client::vpn_helper::{
    answer_for, ask_helper, device_name_from, elevated_install, read_join, service_proof,
    tailscale_path, HelperReply, VpnConnection,
};
use serde_json::{json, Map, Value};
use service::{FakeInstaller, FakeService, Scripted};
use std::path::Path;
use std::time::Duration;

const SECRET: &str = "secret";

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[tokio::test]
async fn answers_the_challenge_and_never_sends_the_secret() {
    let helper = Scripted::start(
        |ours| service_proof(SECRET, "abc", ours),
        r#"{"ok":true,"version":1,"nodeId":null}"#,
    );
    let reply = ask_helper("status", Map::new(), SECRET, helper.port).await;
    assert_eq!(
        reply,
        Some(HelperReply {
            ok: true,
            version: Some(1.0),
            ..HelperReply::default()
        })
    );
    let seen = helper.order().expect("the order arrived");
    assert_eq!(seen["answer"], answer_for(SECRET, "abc"));
    assert_eq!(seen["order"], "status");
    assert!(!seen.to_string().contains(SECRET));
}

#[tokio::test]
async fn tells_nothing_to_a_program_that_cannot_prove_it_is_the_service() {
    let helper = Scripted::start(|_| "0".repeat(64), "{}");
    let order = fields(json!({ "own": { "privateKey": "provider key" } }));
    assert_eq!(ask_helper("up", order, SECRET, helper.port).await, None);
    assert!(helper.order().is_none());
}

#[test]
fn computes_the_same_proof_as_the_service() {
    assert_eq!(
        service_proof("secret", "nonce", "theirs"),
        "2865656d4a1a945e17feecd85db6dfefd819b0f11a884a3f9503bf36fb1e3814"
    );
    assert!(service::verify(
        SECRET,
        "nonce",
        &answer_for(SECRET, "nonce")
    ));
}

#[tokio::test]
async fn is_none_when_nothing_listens() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    assert_eq!(ask_helper("status", Map::new(), SECRET, port).await, None);
}

#[tokio::test]
async fn is_none_on_an_answer_that_is_not_one() {
    let helper = Scripted::start(|ours| service_proof(SECRET, "abc", ours), "not json");
    assert_eq!(
        ask_helper("status", Map::new(), SECRET, helper.port).await,
        None
    );
    let helper = Scripted::start(
        |ours| service_proof(SECRET, "abc", ours),
        r#"{"ok":true,"code":null}"#,
    );
    assert_eq!(
        ask_helper("status", Map::new(), SECRET, helper.port).await,
        None
    );
}

#[tokio::test]
async fn speaks_to_the_service_as_its_source_reads() {
    let service = FakeService::start();
    service.installed(SECRET, 1);
    let reply = ask_helper("status", Map::new(), SECRET, service.port).await;
    assert_eq!(
        reply.map(|reply| (reply.ok, reply.version)),
        Some((true, Some(1.0)))
    );
    let refused = ask_helper("status", Map::new(), "another", service.port).await;
    assert_eq!(
        refused, None,
        "a service proving another secret is not ours"
    );
}

#[test]
fn keeps_paths_out_of_the_script_on_windows() {
    let launch = elevated_install("win32", r"C:\a'b\h.exe", r"C:\s");
    assert_eq!(launch.file, "powershell.exe");
    assert!(!launch.args.join(" ").contains("a'b"));
    assert!(launch
        .env
        .contains(&("POLARIS_VPN_HELPER".into(), r"C:\a'b\h.exe".into())));
}

#[test]
fn keeps_paths_out_of_the_script_on_macos() {
    let launch = elevated_install("darwin", "/Apps/a\"b/h", "/s");
    assert_eq!(launch.file, "/usr/bin/osascript");
    assert!(!launch.args.join(" ").contains("a\"b"));
}

#[test]
fn hands_linux_an_argument_list() {
    let launch = elevated_install("linux", "/h", "/s");
    assert_eq!(launch.file, "pkexec");
    assert_eq!(launch.args, ["/h", "install", "/s"]);
    assert!(launch.env.is_empty());
}

#[test]
fn takes_a_server_and_a_one_time_key() {
    let input = read_join(&json!({ "server": "https://vpn.example.com", "key": "abcd1234" }));
    assert_eq!(
        input.map(|input| input.server).as_deref(),
        Some("https://vpn.example.com")
    );
    let trimmed = read_join(&json!({ "server": " https://vpn.example.com ", "key": "abcd1234" }));
    assert_eq!(
        trimmed.map(|input| input.server).as_deref(),
        Some("https://vpn.example.com")
    );
}

#[test]
fn refuses_another_scheme_and_a_key_with_spaces() {
    assert!(read_join(&json!({ "server": "file:///etc/passwd", "key": "abcd1234" })).is_none());
    assert!(read_join(&json!({ "server": "https://x", "key": "a b c d e f g" })).is_none());
    assert!(read_join(&json!({ "server": "not a url", "key": "abcd1234" })).is_none());
    assert!(read_join(&json!({ "server": "https://x", "key": "abc" })).is_none());
    let extra = json!({ "server": "https://x", "key": "abcd1234", "flag": "--reset" });
    assert!(read_join(&extra).is_none());
}

#[test]
fn names_the_client_for_each_system() {
    assert!(tailscale_path("win32").contains("tailscale.exe"));
    assert_eq!(tailscale_path("linux"), "tailscale");
    assert!(tailscale_path("darwin").starts_with("/Applications/"));
}

#[test]
fn makes_a_device_name_out_of_any_hostname() {
    assert_eq!(device_name_from("DESKTOP-ABC123"), "DESKTOP-ABC123");
    assert_eq!(device_name_from("***"), "Computer");
    assert_eq!(device_name_from(&"a".repeat(60)).len(), 40);
    assert_eq!(device_name_from(" Mi port\u{e1}til; "), "Mi port\u{e1}til");
}

fn connection() -> Value {
    json!({
        "nodeId": "3f8a1c2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b",
        "address": "10.128.0.2/32",
        "dns": ["1.1.1.1"],
        "nodePublicKey": "k",
        "endpoint": "198.51.100.1",
        "port": 51820
    })
}

fn own() -> Value {
    json!({
        "privateKey": "p", "presharedKey": null, "moreAddresses": [],
        "allowedIps": ["0.0.0.0/0"], "mtu": 1320
    })
}

#[test]
fn reads_a_tunnel_as_polaris_answered_it() {
    assert!(VpnConnection::read(&connection()).is_some());
    let mut with_own = connection();
    with_own["own"] = own();
    let read = VpnConnection::read(&with_own).unwrap();
    assert_eq!(read.fields()["own"]["presharedKey"], Value::Null);
    assert!(read.fields().get("order").is_none());
}

#[test]
fn refuses_a_tunnel_out_of_its_limits() {
    let changed = |key: &str, value: Value| {
        let mut body = connection();
        body[key] = value;
        VpnConnection::read(&body)
    };
    assert!(changed("nodeId", json!("not-a-uuid")).is_none());
    assert!(changed("port", json!(0)).is_none());
    assert!(changed("port", json!(70000)).is_none());
    assert!(changed("address", json!("")).is_none());
    assert!(changed("dns", json!(["a", "b", "c", "d", "e"])).is_none());
    assert!(changed("endpoint", json!("e".repeat(256))).is_none());
    assert!(changed("order", json!("down")).is_none());
    let mut no_psk = own();
    no_psk.as_object_mut().unwrap().remove("presharedKey");
    assert!(changed("own", no_psk).is_none());
    let mut tiny = own();
    tiny["mtu"] = json!(100);
    assert!(changed("own", tiny).is_none());
    let mut nothing_carried = own();
    nothing_carried["allowedIps"] = json!([]);
    assert!(changed("own", nothing_carried).is_none());
}

fn vpn(dir: &Path, service: &FakeService, installer: FakeInstaller) -> Vpn<FakeInstaller> {
    Vpn::new(dir.join("vpn-secret"), installer).with_port(
        service.port,
        Duration::from_secs(2),
        Duration::from_millis(20),
    )
}

#[tokio::test]
async fn status_never_installs_anything() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let installer = FakeInstaller::new(&service, true);
    let vpn = vpn(dir.path(), &service, installer.clone());
    assert_eq!(vpn.status().await, None);
    assert_eq!(installer.calls(), 0);
}

#[tokio::test]
async fn installs_the_service_the_first_time_and_asks_it_for_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let installer = FakeInstaller::new(&service, true);
    let vpn = vpn(dir.path(), &service, installer.clone());
    assert_eq!(vpn.key().await.as_deref(), Some(service::PUBLIC_KEY));
    assert_eq!(installer.calls(), 1);
    assert_eq!(vpn.key().await.as_deref(), Some(service::PUBLIC_KEY));
    assert_eq!(
        installer.calls(),
        1,
        "a current service is not installed again"
    );
}

#[tokio::test]
async fn replaces_an_older_service() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let secret = read_secret(&dir.path().join("vpn-secret")).await.unwrap();
    service.installed(&secret, 0);
    let installer = FakeInstaller::new(&service, true);
    let vpn = vpn(dir.path(), &service, installer.clone());
    assert!(vpn.key().await.is_some());
    assert_eq!(installer.calls(), 1);
}

#[tokio::test]
async fn a_prompt_turned_down_is_denied() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let vpn = vpn(dir.path(), &service, FakeInstaller::new(&service, false));
    let connection = VpnConnection::read(&connection()).unwrap();
    assert_eq!(vpn.up(&connection).await, Err("denied".into()));
    assert_eq!(vpn.key().await, None);
}

#[tokio::test]
async fn brings_the_tunnel_up_and_down() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let vpn = vpn(dir.path(), &service, FakeInstaller::new(&service, true));
    let mut body = connection();
    body["own"] = own();
    let connection = VpnConnection::read(&body).unwrap();
    assert_eq!(vpn.up(&connection).await, Ok(()));
    assert_eq!(
        vpn.status().await.as_deref(),
        Some("3f8a1c2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b")
    );
    assert_eq!(vpn.down().await, Ok(()));
    assert_eq!(vpn.status().await, None);
}

#[tokio::test]
async fn passes_on_the_word_the_service_refuses_with() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let vpn = vpn(dir.path(), &service, FakeInstaller::new(&service, true));
    service.refuse_up("tunnel");
    let connection = VpnConnection::read(&connection()).unwrap();
    assert_eq!(vpn.up(&connection).await, Err("tunnel".into()));
}

#[tokio::test]
async fn down_without_a_service_failed() {
    let dir = tempfile::tempdir().unwrap();
    let service = FakeService::start();
    let installer = FakeInstaller::new(&service, true);
    let vpn = vpn(dir.path(), &service, installer.clone());
    assert_eq!(vpn.down().await, Err("failed".into()));
    assert_eq!(installer.calls(), 0);
}

#[tokio::test]
async fn keeps_one_secret_and_replaces_a_damaged_one() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("vpn-secret");
    let made = read_secret(&file).await.unwrap();
    assert_eq!(made.len(), 64);
    assert!(made.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(read_secret(&file).await.unwrap(), made);
    std::fs::write(&file, format!("{made}\n")).unwrap();
    assert_eq!(read_secret(&file).await.unwrap(), made);
    std::fs::write(&file, "not a secret").unwrap();
    let fresh = read_secret(&file).await.unwrap();
    assert_ne!(fresh, made);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), fresh);
}

#[tokio::test]
async fn joining_without_the_client_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let input =
        read_join(&json!({ "server": "https://vpn.example.com", "key": "abcd1234" })).unwrap();
    let missing = dir.path().join("no-tailscale-here");
    assert_eq!(join_network(&missing, &input).await, Err("noClient".into()));
}
