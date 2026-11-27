//! The Polaris account this terminal is signed in to: the instance's origin and
//! the `terminal` API key that instance handed over (docs/terminal-integration.md,
//! "Auth and sign-in"). Both live in the OS keychain through secure storage,
//! never in settings or on disk in the clear.

use ptermui::AppContext;
use ptermui_extras::secure_storage::AppContextExt as _;

/// Secure-storage key of the instance's origin, e.g. `https://polaris.example.com`.
const INSTANCE_KEY: &str = "PolarisInstanceOrigin";
/// Secure-storage key of the terminal's API key.
const TERMINAL_KEY: &str = "PolarisTerminalKey";

/// A signed-in account: where the instance is and the key it issued.
#[derive(Clone, PartialEq, Eq)]
pub struct PolarisAccount {
    pub origin: String,
    pub key: String,
}

impl std::fmt::Debug for PolarisAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PolarisAccount")
            .field("origin", &self.origin)
            .field("key", &"<redacted>")
            .finish()
    }
}

/// The stored account, or `None` when this terminal is not signed in.
pub fn stored(ctx: &AppContext) -> Option<PolarisAccount> {
    let storage = ctx.secure_storage();
    let origin = storage.read_value(INSTANCE_KEY).ok()?;
    let key = storage.read_value(TERMINAL_KEY).ok()?;
    if origin.trim().is_empty() || key.trim().is_empty() {
        return None;
    }
    Some(PolarisAccount {
        origin: origin.trim().trim_end_matches('/').to_owned(),
        key: key.trim().to_owned(),
    })
}

/// The relay address for an instance origin: `https` becomes `wss`, `http` `ws`.
pub fn relay_url(origin: &str) -> Option<String> {
    let origin = origin.trim_end_matches('/');
    let rest = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return None;
    };
    Some(format!("{rest}{}?role=instance", polaris_relay::RELAY_PATH))
}

#[cfg(test)]
#[path = "polaris_account_tests.rs"]
mod tests;
