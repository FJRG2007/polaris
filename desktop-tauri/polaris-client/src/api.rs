//! Calls to the Polaris API with an API key: the routes the Electron app's
//! `polaris-api.ts`, `key-flow.ts` and `push-local.ts` already call, with the
//! same `Authorization: Bearer <key>` header and the same refusals.

use crate::address::{ApiKey, InstanceUrl};
use crate::instance::{Failover, FetchError};
use crate::net::NetFailure;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::sync::Arc;
use tokio::io::AsyncRead;

/// Shown when the instance answers 401 (`KEY_REFUSED` in `polaris-api.ts`).
pub const KEY_REFUSED: &str =
    "The API key was refused - it may have been revoked or have expired. Paste a new one.";
const NOT_UNDERSTOOD: &str = "Polaris answered with something this app does not understand.";

/// Why a call did not give an answer. `Display` is the sentence for the reader.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{KEY_REFUSED}")]
    KeyRefused,
    /// Polaris refused the call; `message` is its own `error` field when it sent one.
    #[error("{message}")]
    Refused { status: u16, message: String },
    #[error("{message}")]
    Unreachable {
        failure: NetFailure,
        message: String,
    },
    #[error("{NOT_UNDERSTOOD}")]
    Unexpected { status: u16 },
    #[error("{0} is not a valid id.")]
    InvalidId(String),
}

impl ApiError {
    /// The HTTP status behind the error, 0 when nothing answered.
    pub fn status(&self) -> u16 {
        match self {
            Self::KeyRefused => 401,
            Self::Refused { status, .. } | Self::Unexpected { status } => *status,
            Self::Unreachable { .. } | Self::InvalidId(_) => 0,
        }
    }
}

/// `GET /api/v1/me`, used to check a pasted key before it is kept.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Me {
    pub user: MeUser,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MeUser {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

/// `GET /api/v1/deploy/services/<id>/image`: where a locally built image is tagged.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ImageTarget {
    pub repository: String,
}

/// `POST /api/v1/deploy/services/<id>/image`: the deployment the upload started.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub deployment_id: String,
}

/// `GET /api/v1/deploy/deployments/<id>?tail=1`: where a deployment stands.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentState {
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub done: bool,
    #[serde(default)]
    pub next_offset: Option<u64>,
}

/// A Polaris and the key to call it with.
///
/// With a failover (`with_failover`), every call goes to the address that
/// answers: the usual one, or a local address of the same Polaris that proved it
/// by signature (`instance::Failover`). The key is only ever sent to those.
#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    server: InstanceUrl,
    key: ApiKey,
    failover: Option<Arc<Failover>>,
}

impl ApiClient {
    pub fn new(http: reqwest::Client, server: InstanceUrl, key: ApiKey) -> Self {
        Self {
            http,
            server,
            key,
            failover: None,
        }
    }

    /// Calls through `failover`, which is used only when it is the one for this
    /// same server.
    pub fn with_failover(mut self, failover: Arc<Failover>) -> Self {
        if failover.primary() == self.server.as_str() {
            self.failover = Some(failover);
        }
        self
    }

    /// "Using your local network address" while on one, otherwise `None`.
    pub fn address_words(&self) -> Option<&'static str> {
        self.failover.as_ref().and_then(|f| f.status().words)
    }

    pub fn server(&self) -> &InstanceUrl {
        &self.server
    }

    pub async fn me(&self) -> Result<Me, ApiError> {
        self.call_json(&["api", "v1", "me"], &[]).await
    }

    pub async fn image_target(&self, service_id: &str) -> Result<ImageTarget, ApiError> {
        let target: ImageTarget = self
            .call_json(
                &["api", "v1", "deploy", "services", id(service_id)?, "image"],
                &[],
            )
            .await?;
        if target.repository.is_empty() || target.repository.chars().count() > 512 {
            return Err(ApiError::Unexpected { status: 200 });
        }
        Ok(target)
    }

    pub async fn deployment_state(&self, deployment_id: &str) -> Result<DeploymentState, ApiError> {
        self.call_json(
            &["api", "v1", "deploy", "deployments", id(deployment_id)?],
            &[("tail", "1")],
        )
        .await
    }

    /// A request with the key, answering the response when it is a 2xx. A
    /// streamed answer (a followed build log) is read as it arrives.
    pub async fn call(
        &self,
        method: reqwest::Method,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<reqwest::Response, ApiError> {
        let path = self.path(segments, query);
        let make = |url: &str| {
            self.http
                .request(method.clone(), url)
                .bearer_auth(self.key.secret())
                .header(reqwest::header::CACHE_CONTROL, "no-store")
        };
        let answer = match &self.failover {
            Some(failover) => failover.request(&path, make).await,
            None => make(&format!("{}{path}", self.server.as_str()))
                .send()
                .await
                .map_err(FetchError::from),
        };
        let response = answer.map_err(|error| self.unreachable(error.failure()))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        Err(refusal(
            status,
            response.json::<serde_json::Value>().await.ok(),
        ))
    }

    /// A JSON answer to a GET, checked against the shape the route documents.
    pub async fn call_json<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<T, ApiError> {
        let response = self.call(reqwest::Method::GET, segments, query).await?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|error| self.unreachable(NetFailure::classify(&error)))?;
        serde_json::from_slice(&body).map_err(|_| ApiError::Unexpected { status })
    }

    /// POST a file as the body, streamed: read as the network takes it, never
    /// held in memory - an image archive can be gigabytes. Sent with chunked
    /// encoding to the address the failover resolves to. Answers the parsed JSON
    /// body (`Null` when it was not JSON).
    pub async fn send_file<R>(
        &self,
        segments: &[&str],
        body: R,
        headers: &[(&str, &str)],
    ) -> Result<serde_json::Value, ApiError>
    where
        R: AsyncRead + Send + 'static,
    {
        let origin = match &self.failover {
            Some(failover) => failover.resolve().await,
            None => self.server.as_str().to_owned(),
        };
        let mut request = self
            .http
            .post(format!("{origin}{}", self.path(segments, &[])))
            .bearer_auth(self.key.secret())
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .body(reqwest::Body::wrap_stream(
                tokio_util::io::ReaderStream::new(body),
            ));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request
            .send()
            .await
            .map_err(|error| self.unreachable(NetFailure::classify(&error)))?;
        let status = response.status().as_u16();
        let text = response
            .bytes()
            .await
            .map_err(|error| self.unreachable(NetFailure::classify(&error)))?;
        let parsed = serde_json::from_slice(&text).unwrap_or(serde_json::Value::Null);
        if !(200..300).contains(&status) {
            return Err(refusal(status, Some(parsed)));
        }
        Ok(parsed)
    }

    /// `/segment/segment?query`, each segment escaped as one.
    fn path(&self, segments: &[&str], query: &[(&str, &str)]) -> String {
        let mut url = self.server.to_url();
        url.path_segments_mut()
            .expect("an origin can take a path")
            .clear()
            .extend(segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        url[url::Position::BeforePath..].to_owned()
    }

    fn unreachable(&self, failure: NetFailure) -> ApiError {
        ApiError::Unreachable {
            failure,
            message: failure.describe(self.server.host()),
        }
    }
}
/// An id put into a path: bounded and made of URL-safe characters only, so it
/// stays one segment.
pub fn id(text: &str) -> Result<&str, ApiError> {
    let fits = (1..=64).contains(&text.len())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if fits {
        Ok(text)
    } else {
        Err(ApiError::InvalidId(text.chars().take(64).collect()))
    }
}

fn refusal(status: u16, body: Option<serde_json::Value>) -> ApiError {
    if status == 401 {
        return ApiError::KeyRefused;
    }
    let said = body
        .as_ref()
        .and_then(|body| body.get("error"))
        .and_then(|error| error.as_str());
    let message = said.map_or_else(
        || format!("Polaris answered with HTTP {status}."),
        str::to_owned,
    );
    ApiError::Refused { status, message }
}
