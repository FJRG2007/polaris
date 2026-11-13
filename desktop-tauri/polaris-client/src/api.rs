//! Calls to the Polaris API with an API key: the routes the Electron app's
//! `polaris-api.ts`, `key-flow.ts` and `push-local.ts` already call, with the
//! same `Authorization: Bearer <key>` header and the same refusals.

use crate::address::{ApiKey, InstanceUrl};
use crate::net::NetFailure;
use serde::de::DeserializeOwned;
use serde::Deserialize;

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
#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    server: InstanceUrl,
    key: ApiKey,
}

impl ApiClient {
    pub fn new(http: reqwest::Client, server: InstanceUrl, key: ApiKey) -> Self {
        Self { http, server, key }
    }

    pub fn server(&self) -> &InstanceUrl {
        &self.server
    }

    pub async fn me(&self) -> Result<Me, ApiError> {
        self.get_json(&["api", "v1", "me"], &[]).await
    }

    pub async fn image_target(&self, service_id: &str) -> Result<ImageTarget, ApiError> {
        let target: ImageTarget = self
            .get_json(
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
        self.get_json(
            &["api", "v1", "deploy", "deployments", id(deployment_id)?],
            &[("tail", "1")],
        )
        .await
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<T, ApiError> {
        let mut url = self.server.to_url();
        url.path_segments_mut()
            .expect("an origin can take a path")
            .clear()
            .extend(segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(self.key.secret())
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|error| self.unreachable(&error))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(refusal(
                status,
                response.json::<serde_json::Value>().await.ok(),
            ));
        }
        let body = response
            .bytes()
            .await
            .map_err(|error| self.unreachable(&error))?;
        serde_json::from_slice(&body).map_err(|_| ApiError::Unexpected { status })
    }

    fn unreachable(&self, error: &reqwest::Error) -> ApiError {
        let failure = NetFailure::classify(error);
        ApiError::Unreachable {
            failure,
            message: failure.describe(self.server.host()),
        }
    }
}

/// An id put into a path: bounded and made of URL-safe characters only, so it
/// stays one segment.
fn id(text: &str) -> Result<&str, ApiError> {
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
