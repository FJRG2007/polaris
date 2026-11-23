//! Persisting a member's storage to a store the host owns (IndexedDB in a
//! browser, the server's database behind napi).
//!
//! OpenMLS's `StorageProvider` is synchronous and those stores are not, so a
//! member runs over [`MemoryStorage`] and the host persists what changed after
//! each operation: [`Journal::changes`] returns every key written or deleted
//! since the last call, and the host writes the whole list in ONE transaction.
//!
//! Crash safety follows from that one rule. A process that dies before the
//! transaction commits restarts from the store as it was before the operation
//! (the operation never happened, and the commit or message it produced was
//! never handed out); one that dies after restarts with the operation applied.
//! There is no state in between. When persisting fails, the host drops the
//! member and restores it from the store, which is the same as a crash.

use std::collections::HashMap;
use std::sync::Mutex;

use super::MemoryStorage;

/// One key's change: `value` is `None` when the key was deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreChange {
    pub key: Vec<u8>,
    pub value: Option<Vec<u8>>,
}

/// What the host's store holds for one device, as last reported.
#[derive(Default)]
pub struct Journal {
    persisted: Mutex<HashMap<Vec<u8>, Vec<u8>>>,
}

impl Journal {
    /// A storage filled from the host's store, and the journal that knows the
    /// store already holds exactly that.
    pub fn restore(
        entries: impl IntoIterator<Item = (Vec<u8>, Vec<u8>)>,
    ) -> (MemoryStorage, Journal) {
        let values: HashMap<Vec<u8>, Vec<u8>> = entries.into_iter().collect();
        let storage = MemoryStorage::default();
        *storage.values.write().unwrap_or_else(|e| e.into_inner()) = values.clone();
        (
            storage,
            Journal {
                persisted: Mutex::new(values),
            },
        )
    }

    /// Every key `storage` changed since the last call (or since
    /// [`Journal::restore`]), sorted by key so the list is deterministic.
    /// The journal then assumes the host persists them.
    pub fn changes(&self, storage: &MemoryStorage) -> Vec<StoreChange> {
        let current = storage.values.read().unwrap_or_else(|e| e.into_inner());
        let mut persisted = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<StoreChange> = current
            .iter()
            .filter(|(key, value)| persisted.get(*key) != Some(*value))
            .map(|(key, value)| StoreChange {
                key: key.clone(),
                value: Some(value.clone()),
            })
            .collect();
        out.extend(
            persisted
                .keys()
                .filter(|key| !current.contains_key(*key))
                .map(|key| StoreChange {
                    key: key.clone(),
                    value: None,
                }),
        );
        out.sort_by(|a, b| a.key.cmp(&b.key));
        for change in &out {
            match &change.value {
                Some(value) => persisted.insert(change.key.clone(), value.clone()),
                None => persisted.remove(&change.key),
            };
        }
        out
    }
}
