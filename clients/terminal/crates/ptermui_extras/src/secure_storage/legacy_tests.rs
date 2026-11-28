use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use super::*;

/// An in-memory store whose contents the test can still inspect after handing
/// it to the wrapper.
#[derive(Clone, Default)]
struct Memory(Rc<RefCell<HashMap<String, String>>>);

impl Memory {
    fn with(entries: &[(&str, &str)]) -> Self {
        let memory = Self::default();
        for (key, value) in entries {
            memory
                .0
                .borrow_mut()
                .insert((*key).to_owned(), (*value).to_owned());
        }
        memory
    }

    fn get(&self, key: &str) -> Option<String> {
        self.0.borrow().get(key).cloned()
    }
}

impl SecureStorage for Memory {
    fn write_value(&self, key: &str, value: &str) -> Result<(), Error> {
        self.0.borrow_mut().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn read_value(&self, key: &str) -> Result<String, Error> {
        self.get(key).ok_or(Error::NotFound)
    }

    fn remove_value(&self, key: &str) -> Result<(), Error> {
        self.0.borrow_mut().remove(key);
        Ok(())
    }
}

fn storage(current: &Memory, legacy: &Memory) -> WithLegacy {
    WithLegacy::new(Box::new(current.clone()), Box::new(legacy.clone()))
}

#[test]
fn a_value_only_the_old_app_had_is_read_and_copied_once() {
    let current = Memory::default();
    let legacy = Memory::with(&[("ApiKey", "secret")]);
    let storage = storage(&current, &legacy);

    assert_eq!(storage.read_value("ApiKey").unwrap(), "secret");
    assert_eq!(current.get("ApiKey").as_deref(), Some("secret"));
    assert_eq!(legacy.get("ApiKey").as_deref(), Some("secret"));
}

#[test]
fn the_current_value_wins_over_the_old_one() {
    let current = Memory::with(&[("ApiKey", "new")]);
    let legacy = Memory::with(&[("ApiKey", "old")]);
    assert_eq!(
        storage(&current, &legacy).read_value("ApiKey").unwrap(),
        "new"
    );
}

#[test]
fn a_copied_value_removed_later_stays_removed() {
    let current = Memory::default();
    let legacy = Memory::with(&[("ApiKey", "secret")]);
    let storage = storage(&current, &legacy);

    storage.read_value("ApiKey").unwrap();
    storage.remove_value("ApiKey").unwrap();
    assert!(matches!(storage.read_value("ApiKey"), Err(Error::NotFound)));
    assert_eq!(legacy.get("ApiKey").as_deref(), Some("secret"));
}

#[test]
fn a_value_neither_app_has_is_not_found() {
    let storage = storage(&Memory::default(), &Memory::default());
    assert!(matches!(storage.read_value("ApiKey"), Err(Error::NotFound)));
}

#[test]
fn writes_and_removals_never_touch_the_old_app() {
    let current = Memory::default();
    let legacy = Memory::with(&[("ApiKey", "old")]);
    let storage = storage(&current, &legacy);

    storage.write_value("ApiKey", "new").unwrap();
    storage.remove_value("ApiKey").unwrap();
    assert!(matches!(storage.read_value("ApiKey"), Err(Error::NotFound)));
    assert_eq!(legacy.get("ApiKey").as_deref(), Some("old"));
}
