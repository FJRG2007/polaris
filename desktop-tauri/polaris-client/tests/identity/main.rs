//! The identity probe against a local mock server: no network leaves the machine.

use polaris_client::identity::probe_within;
use polaris_client::{probe, probe_client, InstanceUrl, NetFailure, Verdict};
use serde_json::json;
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn verdict_of(server: &MockServer) -> Verdict {
    let origin = InstanceUrl::parse(&server.uri()).expect("a mock server is on loopback");
    probe(&probe_client().unwrap(), &origin).await
}

fn json_reply(status: u16, body: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(body)
}

#[tokio::test]
async fn identity_names_the_polaris() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/polaris/identity"))
        .respond_with(json_reply(
            200,
            json!({ "product": "polaris", "protocol": 1, "name": " Home ", "version": "2.3.0" }),
        ))
        .mount(&server)
        .await;
    assert_eq!(
        verdict_of(&server).await,
        Verdict::Polaris {
            name: Some("Home".into()),
            version: Some("2.3.0".into()),
            legacy: false
        }
    );
}

#[tokio::test]
async fn another_product_is_not_polaris() {
    let server = MockServer::start().await;
    Mock::given(path("/api/polaris/identity"))
        .respond_with(json_reply(
            200,
            json!({ "product": "other", "protocol": 1 }),
        ))
        .mount(&server)
        .await;
    assert_eq!(verdict_of(&server).await, Verdict::NotPolaris);
}

#[tokio::test]
async fn an_older_polaris_answers_on_instance() {
    let server = MockServer::start().await;
    Mock::given(path("/api/instance"))
        .respond_with(json_reply(
            200,
            json!({ "id": "abcdefgh", "publicKey": "a".repeat(43), "addresses": [] }),
        ))
        .mount(&server)
        .await;
    assert_eq!(
        verdict_of(&server).await,
        Verdict::Polaris {
            name: None,
            version: None,
            legacy: true
        }
    );
}

#[tokio::test]
async fn a_starting_polaris_answers_health_503() {
    let server = MockServer::start().await;
    Mock::given(path("/api/health"))
        .respond_with(json_reply(503, json!({ "status": "error" })))
        .mount(&server)
        .await;
    assert_eq!(verdict_of(&server).await, Verdict::Starting);
}

#[tokio::test]
async fn an_oversized_answer_is_not_read() {
    let server = MockServer::start().await;
    let name = "x".repeat(5_000);
    Mock::given(path("/api/polaris/identity"))
        .respond_with(json_reply(
            200,
            json!({ "product": "polaris", "protocol": 1, "name": name }),
        ))
        .mount(&server)
        .await;
    assert_eq!(verdict_of(&server).await, Verdict::NotPolaris);
}

#[tokio::test]
async fn a_redirect_elsewhere_is_reported() {
    let server = MockServer::start().await;
    Mock::given(path("/api/polaris/identity"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "https://login.example.com/"),
        )
        .mount(&server)
        .await;
    assert_eq!(verdict_of(&server).await, Verdict::Redirects);
}

#[tokio::test]
async fn a_slow_server_times_out() {
    let server = MockServer::start().await;
    Mock::given(path("/api/polaris/identity"))
        .respond_with(json_reply(200, json!({})).set_delay(Duration::from_secs(2)))
        .mount(&server)
        .await;
    let origin = InstanceUrl::parse(&server.uri()).unwrap();
    let verdict = probe_within(
        &probe_client().unwrap(),
        &origin,
        Duration::from_millis(200),
    )
    .await;
    assert_eq!(verdict, Verdict::Unreachable(NetFailure::TimedOut));
}

#[tokio::test]
async fn nothing_listening_is_refused() {
    // A port taken and released at once: wiremock keeps dropped servers
    // listening in a pool, so one of those would still answer.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let origin = InstanceUrl::parse(&format!("http://127.0.0.1:{port}")).unwrap();
    let verdict = probe(&probe_client().unwrap(), &origin).await;
    assert_eq!(verdict, Verdict::Unreachable(NetFailure::Refused));
    assert!(verdict
        .describe(origin.host())
        .starts_with("Nothing is answering at 127.0.0.1:"));
}
