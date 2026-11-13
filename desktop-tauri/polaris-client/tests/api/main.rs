//! The API-key calls against a local mock server: no network leaves the machine.

use polaris_client::api::KEY_REFUSED;
use polaris_client::{ApiClient, ApiError, ApiKey, DeploymentState, InstanceUrl};
use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEY: &str = "plk_abcd1234.fixture-secret";

fn client_for(server: &MockServer) -> ApiClient {
    let origin = InstanceUrl::parse(&server.uri()).unwrap();
    ApiClient::new(reqwest::Client::new(), origin, ApiKey::parse(KEY).unwrap())
}

#[tokio::test]
async fn me_sends_the_key_as_a_bearer_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/me"))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "user": { "name": "Ada", "username": null } })),
        )
        .expect(1)
        .mount(&server)
        .await;
    let me = client_for(&server).me().await.unwrap();
    assert_eq!(me.user.name.as_deref(), Some("Ada"));
    assert_eq!(me.user.username, None);
}

#[tokio::test]
async fn a_401_is_the_key_refused() {
    let server = MockServer::start().await;
    Mock::given(path("/api/v1/me"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;
    let error = client_for(&server).me().await.unwrap_err();
    assert!(matches!(error, ApiError::KeyRefused));
    assert_eq!(error.to_string(), KEY_REFUSED);
}

#[tokio::test]
async fn a_refusal_carries_the_servers_own_words() {
    let server = MockServer::start().await;
    Mock::given(path("/api/v1/deploy/services/svc_1/image"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({ "error": "This key cannot deploy." })),
        )
        .mount(&server)
        .await;
    let error = client_for(&server).image_target("svc_1").await.unwrap_err();
    assert_eq!(error.status(), 403);
    assert_eq!(error.to_string(), "This key cannot deploy.");

    Mock::given(path("/api/v1/deploy/services/svc_2/image"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    assert_eq!(
        client_for(&server)
            .image_target("svc_2")
            .await
            .unwrap_err()
            .to_string(),
        "Polaris answered with HTTP 500."
    );
}

#[tokio::test]
async fn deployment_state_reads_the_tail() {
    let server = MockServer::start().await;
    Mock::given(path("/api/v1/deploy/deployments/dep_9"))
        .and(query_param("tail", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "status": "running", "done": true, "nextOffset": 120 })),
        )
        .mount(&server)
        .await;
    let state = client_for(&server).deployment_state("dep_9").await.unwrap();
    assert_eq!(
        state,
        DeploymentState {
            status: "running".into(),
            error: None,
            done: true,
            next_offset: Some(120)
        }
    );
}

#[tokio::test]
async fn an_unreadable_answer_is_unexpected() {
    let server = MockServer::start().await;
    Mock::given(path("/api/v1/me"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
        .mount(&server)
        .await;
    assert!(matches!(
        client_for(&server).me().await.unwrap_err(),
        ApiError::Unexpected { status: 200 }
    ));
}

#[tokio::test]
async fn an_id_cannot_leave_its_segment() {
    let server = MockServer::start().await;
    let error = client_for(&server)
        .deployment_state("../me")
        .await
        .unwrap_err();
    assert!(matches!(error, ApiError::InvalidId(_)));
}
