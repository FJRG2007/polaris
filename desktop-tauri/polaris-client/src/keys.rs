//! The API key used to push from this computer: kept by the operating system,
//! checked against the instance before it is kept.
//!
//! Mirrors `desktop/src/main/api-key-store.ts` and the checking half of
//! `key-flow.ts`. The key lives in the system's credential store (Credential
//! Manager, Keychain, Secret Service) through the `keyring` crate, one entry per
//! Polaris, so switching server cannot send one instance's key to another. It
//! is never written to a file. Where the system has no store (a Linux desktop
//! without a secret service) it is held in memory for as long as the app runs.
//!
//! The beta has its own service name, so it never reads or replaces a key the
//! Electron app kept; Electron's file is encrypted by Chromium and cannot be
//! migrated from here.

use crate::address::{ApiKey, InstanceUrl};
use crate::api::{ApiClient, ApiError};
use std::collections::HashMap;
use std::sync::Mutex;

/// The credential-store service every key is filed under.
pub const KEY_SERVICE: &str = "io.github.fjrg2007.polaris.beta.api-key";

/// Shown in the key form when the instance answers 401 (`REFUSED` in `key-flow.ts`).
pub const REFUSED: &str = "Polaris refused that key - it may have been revoked or have expired.";

/// Where the keys are kept.
pub trait SecretStore: Send + Sync {
    /// Whether a key can be kept here without writing it in plain text.
    fn available(&self) -> bool;
    fn read(&self, server: &str) -> Option<String>;
    /// False when it could not be kept safely.
    fn keep(&self, server: &str, key: &str) -> bool;
    fn forget(&self, server: &str);
}

/// The system's credential store.
#[derive(Debug, Default)]
pub struct SystemStore;

impl SystemStore {
    fn entry(server: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(KEY_SERVICE, server).ok()
    }
}

impl SecretStore for SystemStore {
    fn available(&self) -> bool {
        keyring::Entry::store_status().is_ok()
    }

    fn read(&self, server: &str) -> Option<String> {
        Self::entry(server)?.get_password().ok()
    }

    fn keep(&self, server: &str, key: &str) -> bool {
        Self::entry(server).is_some_and(|entry| entry.set_password(key).is_ok())
    }

    fn forget(&self, server: &str) {
        if let Some(entry) = Self::entry(server) {
            // Nothing kept is the outcome asked for.
            let _ = entry.delete_credential();
        }
    }
}

/// The keys for this run: the store, and the ones held in memory only.
pub struct KeyRing<S: SecretStore> {
    store: S,
    remembered: Mutex<HashMap<String, String>>,
}

impl<S: SecretStore> KeyRing<S> {
    pub fn new(store: S) -> Self {
        Self {
            store,
            remembered: Mutex::new(HashMap::new()),
        }
    }

    pub fn can_keep(&self) -> bool {
        self.store.available()
    }

    fn memory(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.remembered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The key for this Polaris, from this run or the store, or `None`.
    pub fn key_for(&self, server: &InstanceUrl) -> Option<ApiKey> {
        let held = self.memory().get(server.as_str()).cloned();
        let raw = held.or_else(|| self.store.read(server.as_str()))?;
        ApiKey::parse(&raw).ok()
    }

    /// Hold a checked key for this run and keep it where the system can.
    /// Answers whether it was kept beyond this run.
    pub fn remember(&self, server: &InstanceUrl, key: &ApiKey) -> bool {
        self.memory()
            .insert(server.as_str().to_owned(), key.secret().to_owned());
        self.store.available() && self.store.keep(server.as_str(), key.secret())
    }

    /// Forget the key for this Polaris, after it refused it or somebody asked.
    pub fn forget(&self, server: &InstanceUrl) {
        self.memory().remove(server.as_str());
        self.store.forget(server.as_str());
    }
}

/// A key pasted into the form, checked for its shape and then with
/// `GET /api/v1/me`, so a mistyped or revoked key is refused in the form it was
/// pasted into rather than halfway through a push. The error is the sentence
/// the form shows.
pub async fn check_key(
    http: &reqwest::Client,
    server: &InstanceUrl,
    raw: &str,
) -> Result<ApiKey, String> {
    let key = ApiKey::parse(raw).map_err(|error| error.to_string())?;
    match ApiClient::new(http.clone(), server.clone(), key.clone())
        .me()
        .await
    {
        Ok(_) => Ok(key),
        Err(ApiError::KeyRefused) => Err(REFUSED.to_owned()),
        Err(error) => Err(error.to_string()),
    }
}
