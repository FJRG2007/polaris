//! Daemon configuration, read from the environment.
//!
//! The dashboard container (or the systemd unit that launches the daemon)
//! provides these. Every knob keeps a safe default so a bare `polaris-hostd`
//! still comes up on a standard Linux host. All variables share the
//! `POLARIS_HOSTD_` prefix, consistent with the rest of the Polaris fleet.

use std::path::PathBuf;

/// Default Unix socket path. `/run` is tmpfs on systemd hosts, so the socket
/// never survives a reboot (the daemon recreates it, and the token, on start).
const DEFAULT_SOCKET: &str = "/run/polaris/hostd.sock";
const DEFAULT_TOKEN_FILE: &str = "/run/polaris/hostd.token";
const DEFAULT_ROOT: &str = "/";
const DEFAULT_MOUNT_ROOT: &str = "/mnt/polaris";

#[derive(Debug, Clone)]
pub struct Config {
    /// Unix domain socket the API listens on. Only consulted by the unix
    /// transport, hence unused on the non-unix dev shim.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub socket: PathBuf,
    /// Optional TCP fallback (e.g. `127.0.0.1:16081`); bound only when set.
    pub tcp_addr: Option<String>,
    /// Where the freshly generated bearer token is written (mode 0600).
    pub token_file: PathBuf,
    /// Allowlist root for the `/v1/fs/*` endpoints. Paths canonicalizing
    /// outside this are rejected with 403.
    pub root: PathBuf,
    /// Allowlist root for mount targets. Targets outside it are rejected.
    pub mount_root: PathBuf,
    /// Whether the host reports the auto-update capability.
    pub auto_update: bool,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            socket: env("POLARIS_HOSTD_SOCKET")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET)),
            tcp_addr: env("POLARIS_HOSTD_ADDR"),
            token_file: env("POLARIS_HOSTD_TOKEN_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_TOKEN_FILE)),
            root: env("POLARIS_HOSTD_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_ROOT)),
            mount_root: env("POLARIS_HOSTD_MOUNT_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_MOUNT_ROOT)),
            // Auto-update is on unless explicitly disabled. Anything other than
            // a literal "false" leaves it enabled (fail-safe toward the default).
            auto_update: env("POLARIS_HOSTD_AUTOUPDATE")
                .map(|v| !v.eq_ignore_ascii_case("false"))
                .unwrap_or(true),
        }
    }
}
