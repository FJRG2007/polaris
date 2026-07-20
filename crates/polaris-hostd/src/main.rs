//! Polaris host daemon (`polaris-hostd`).
//!
//! A small, privileged daemon that serves the Polaris hostd HTTP API v1 over a
//! Unix domain socket (with an optional TCP fallback). The dashboard container
//! talks to it to broker host-level operations it cannot perform from inside
//! its sandbox: reading and writing host files, and mounting network shares.
//! Its mere presence is what flips the dashboard from the sandboxed edition to
//! the "full" edition - one image, two behaviours.
//!
//! Design constraints (see the module docs for detail): no HTTP framework, std
//! only plus serde, static-musl friendly, and every input treated as hostile
//! because this process runs effectively as root.

mod config;
mod docker;
mod handlers;
mod http;
mod security;
mod server;

use std::sync::Arc;

use crate::config::Config;
use crate::handlers::AppState;

fn main() {
    let config = Config::from_env();

    // A fresh 256-bit bearer token per run: written to the token file for the
    // dashboard to read, required on every request. Rotating on start means a
    // leaked token dies with the daemon.
    let token = security::generate_token();
    if let Err(e) = server::write_token_file(&config.token_file, &token) {
        eprintln!(
            "failed to write token file {}: {e}",
            config.token_file.display()
        );
        std::process::exit(1);
    }

    eprintln!(
        "polaris-hostd {} starting (root={}, mount_root={})",
        env!("CARGO_PKG_VERSION"),
        config.root.display(),
        config.mount_root.display(),
    );

    let state = Arc::new(AppState::new(config, token));
    if let Err(e) = server::run(state) {
        eprintln!("polaris-hostd failed to start: {e}");
        std::process::exit(1);
    }
}
