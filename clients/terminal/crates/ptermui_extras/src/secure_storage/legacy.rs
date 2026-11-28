//! Reading secrets an earlier build kept under another service name.
//!
//! A value missing under the current name is looked up once under the legacy
//! one; when it is there, it is written under the current name and a marker
//! records the copy. Removing a value writes the same marker, so a value removed
//! (a sign-out) is never brought back from the legacy entry. The legacy entry
//! is never written or removed: the older app may still be installed and in use.

use super::{Error, SecureStorage};

/// Suffix of the key that records the legacy service no longer answers for a
/// key: its value was copied, or the value was removed here.
const SETTLED_SUFFIX: &str = ".legacy-settled";

pub struct WithLegacy {
    current: Box<dyn SecureStorage>,
    legacy: Box<dyn SecureStorage>,
}

impl WithLegacy {
    pub fn new(current: Box<dyn SecureStorage>, legacy: Box<dyn SecureStorage>) -> Self {
        Self { current, legacy }
    }

    fn marker(key: &str) -> String {
        format!("{key}{SETTLED_SUFFIX}")
    }
}

impl SecureStorage for WithLegacy {
    fn write_value(&self, key: &str, value: &str) -> Result<(), Error> {
        self.current.write_value(key, value)
    }

    fn write_value_with_owner_only_fallback(&self, key: &str, value: &str) -> Result<(), Error> {
        self.current
            .write_value_with_owner_only_fallback(key, value)
    }

    fn read_value(&self, key: &str) -> Result<String, Error> {
        match self.current.read_value(key) {
            Err(Error::NotFound) => {}
            other => return other,
        }
        let marker = Self::marker(key);
        if self.current.read_value(&marker).is_ok() {
            return Err(Error::NotFound);
        }
        let value = match self.legacy.read_value(key) {
            Ok(value) => value,
            Err(_) => return Err(Error::NotFound),
        };
        match self
            .current
            .write_value_with_owner_only_fallback(key, &value)
            .and_then(|()| self.current.write_value(&marker, "1"))
        {
            Ok(()) => log::info!("Copied secure-storage entry {key} from the previous app"),
            Err(error) => log::warn!("Could not copy secure-storage entry {key}: {error}"),
        }
        Ok(value)
    }

    fn remove_value(&self, key: &str) -> Result<(), Error> {
        self.current.remove_value(key)?;
        // Removed means removed: the legacy entry must not answer for it later.
        if let Err(error) = self.current.write_value(&Self::marker(key), "1") {
            log::warn!("Could not record the removal of secure-storage entry {key}: {error}");
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "legacy_tests.rs"]
mod tests;
