use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use crate::AppId;

#[derive(Debug, Deserialize, Serialize)]
pub struct ChannelConfig {
    /// The application ID for this channel.
    pub app_id: AppId,

    /// The name of the file to which logs should be written.
    pub logfile_name: Cow<'static, str>,

    /// Configuration for talking to Rook's servers.
    pub server_config: RookServerConfig,
    /// Configuration for Oz/ambient agents.
    pub oz_config: OzConfig,
    /// Configuration for telemetry sending, or [`None`] if telemetry should be
    /// disabled for this build.
    pub telemetry_config: Option<TelemetryConfig>,
    /// Configuration for autoupdate functionality.
    pub autoupdate_config: Option<AutoupdateConfig>,
    /// Configuration for crash reporting.
    pub crash_reporting_config: Option<CrashReportingConfig>,
    /// Configuration for statically-bundled MCP OAuth credentials.
    pub mcp_static_config: Option<McpStaticConfig>,
}

/// Configuration for GCP Identity-Aware Proxy authentication, present only on staging builds.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IapConfig {
    /// The IAP OAuth2 client ID used as the audience for identity tokens.
    pub audiences: Cow<'static, str>,
    /// The service account email to impersonate when acquiring IAP credentials.
    pub service_account_email: Cow<'static, str>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RookServerConfig {
    /// The root URL for the standard server pool.
    pub server_root_url: Cow<'static, str>,
    /// The URL for the RTC server, which serves real-time updates for Rook Drive objects.
    pub rtc_server_url: Cow<'static, str>,
    /// The URL for the session sharing server, or [`None`] if session sharing is not
    /// supported.
    pub session_sharing_server_url: Option<Cow<'static, str>>,
    /// The API key to use when making requests to Firebase Authentication endpoints.
    pub firebase_auth_api_key: Cow<'static, str>,
    /// Configuration for GCP Identity-Aware Proxy authentication, present only on
    /// staging builds. [`None`] on production builds.
    #[serde(default)]
    pub iap_config: Option<IapConfig>,
}

impl RookServerConfig {
    /// Rook has no server of its own.
    ///
    /// The hosts below are under `.invalid`, which RFC 2606 reserves so that it
    /// can never be registered or resolve. They are deliberately unreachable
    /// rather than empty: several call sites parse this as a URL and one of
    /// them expects the parse to succeed, so an empty string would panic where
    /// an unresolvable host simply fails the request.
    ///
    /// What this replaces mattered. The rename rewrote upstream's own
    /// `warp.dev` into `rook.dev`, which is registered to someone else and
    /// resolves to live infrastructure, and the shipped OSS binary pointed its
    /// server, RTC, session-sharing and Oz endpoints at it. Nothing is sent at
    /// idle - the OSS channel has no telemetry, crash reporting or autoupdate -
    /// but a login attempt or any cloud feature would have sent requests, and
    /// the credentials in them, to a stranger.
    ///
    /// The Firebase key is empty for the same reason, and it needs its own
    /// treatment because the `.invalid` hosts do not cover it: it is spent
    /// against `securetoken.googleapis.com` and `identitytoolkit.googleapis.com`
    /// (see `FirebaseToken::access_token_url` in `rook_server_auth`), which
    /// resolve, so a token refresh would post the user's refresh token into a
    /// Firebase project this fork does not own. Empty rather than unreachable
    /// because it is a query parameter, not a host - nothing parses it as a
    /// URL - and the request fails on a rejected key.
    pub fn without_server() -> Self {
        Self {
            server_root_url: "https://server.rook.invalid".into(),
            rtc_server_url: "wss://rtc.rook.invalid/graphql/v2".into(),
            session_sharing_server_url: Some("wss://sessions.rook.invalid".into()),
            firebase_auth_api_key: "".into(),
            iap_config: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct OzConfig {
    /// Root URL for the Oz (ambient agent management) dashboard.
    pub oz_root_url: Cow<'static, str>,

    /// URL to use as the audience when issuing workload identity tokens. If [`None`], falls back
    /// to [`RookServerConfig::server_root_url`]. This exists so the audience is not overridden
    /// when a custom server root URL is provided (e.g. an ngrok URL for local development).
    pub workload_audience_url: Option<Cow<'static, str>>,
}

impl OzConfig {
    /// See [`RookServerConfig::without_server`].
    pub fn without_server() -> Self {
        Self {
            oz_root_url: "https://oz.rook.invalid".into(),
            workload_audience_url: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TelemetryConfig {
    /// The name of the file in which not-yet-sent telemetry events will be stored.
    pub telemetry_file_name: Cow<'static, str>,
    /// Configuration for Rudderstack, for reporting telemetry events.
    pub rudderstack_config: Option<RudderStackConfig>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct RudderStackConfig {
    pub write_key: Cow<'static, str>,
    pub root_url: Cow<'static, str>,
    pub ugc_write_key: Cow<'static, str>,
}

impl RudderStackConfig {
    pub fn non_ugc_destination(&self) -> RudderStackDestination {
        RudderStackDestination {
            root_url: self.root_url.clone(),
            write_key: self.write_key.clone(),
        }
    }

    pub fn ugc_destination(&self) -> RudderStackDestination {
        RudderStackDestination {
            root_url: self.root_url.clone(),
            write_key: self.ugc_write_key.clone(),
        }
    }
}

#[derive(Default)]
pub struct RudderStackDestination {
    pub root_url: Cow<'static, str>,
    pub write_key: Cow<'static, str>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AutoupdateConfig {
    /// The base URL for fetching autoupdate versions and updated release bundles.
    pub releases_base_url: Cow<'static, str>,
    /// Whether or not to display menu items relating to autoupdate.
    pub show_autoupdate_menu_items: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CrashReportingConfig {
    /// The URL/DSN for sending error logs and crash reports to Sentry.
    pub sentry_url: Cow<'static, str>,
}

/// Configuration for statically-bundled MCP OAuth credentials.
///
/// These are credentials for OAuth providers where dynamic client registration
/// is not supported and we instead ship pre-registered client IDs and secrets.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpStaticConfig {
    /// Per-provider OAuth credentials.
    pub providers: Vec<McpOAuthProviderConfig>,
}

/// A single OAuth provider's credentials for MCP authentication.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpOAuthProviderConfig {
    /// The issuer URL of the OAuth provider (e.g. `https://github.com/login/oauth`).
    pub issuer: Cow<'static, str>,
    /// The OAuth client ID registered for this channel.
    pub client_id: Cow<'static, str>,
    /// The OAuth client secret registered for this channel.
    pub client_secret: Cow<'static, str>,
    /// A separately registered native client that permits loopback redirects.
    /// This must never be inferred from the custom-scheme client.
    #[serde(default)]
    pub loopback_client: Option<McpOAuthLoopbackClientConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpOAuthLoopbackClientConfig {
    pub client_id: Cow<'static, str>,
    /// Native OAuth clients should normally be public, but retain optional
    /// secret support for providers that require one.
    #[serde(default)]
    pub client_secret: Option<Cow<'static, str>>,
}
