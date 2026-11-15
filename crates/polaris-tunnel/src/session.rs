//! A bounded table of UDP flows: each lives until it has been idle for its
//! timeout, and a new flow past the cap is refused rather than queued. With no
//! timeout, the flow idle the longest makes room for the new one instead.

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Full;

struct Entry<V> {
    value: V,
    seen: Instant,
}

pub struct SessionTable<K, V> {
    map: HashMap<K, Entry<V>>,
    cap: usize,
    idle: Option<Duration>,
}

impl<K: Hash + Eq + Clone, V> SessionTable<K, V> {
    pub fn new(cap: usize, idle: Option<Duration>) -> Self {
        SessionTable {
            map: HashMap::new(),
            cap,
            idle,
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// The flow's value, marked as seen now.
    pub fn touch(&mut self, key: &K, now: Instant) -> Option<&mut V> {
        let entry = self.map.get_mut(key)?;
        entry.seen = now;
        Some(&mut entry.value)
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.map.get(key).map(|e| &e.value)
    }

    /// Add a flow. When the table is full, idle flows are swept first; if none
    /// is, the newest flow is the one refused, so the flows already running
    /// keep going under a flood of new ones. Without a timeout nothing would
    /// ever be swept and the table would refuse everyone for good, so there the
    /// flow idle the longest is dropped (and returned) to make room.
    pub fn insert(&mut self, key: K, value: V, now: Instant) -> Result<Vec<(K, V)>, (Full, V)> {
        let mut expired = Vec::new();
        if !self.map.contains_key(&key) && self.map.len() >= self.cap {
            expired = self.sweep(now);
            if self.map.len() >= self.cap && self.idle.is_none() {
                let oldest = self
                    .map
                    .iter()
                    .min_by_key(|(_, e)| e.seen)
                    .map(|(k, _)| k.clone());
                if let Some(e) = oldest.and_then(|k| self.map.remove(&k).map(|e| (k, e.value))) {
                    expired.push(e);
                }
            }
            if self.map.len() >= self.cap {
                return Err((Full, value));
            }
        }
        self.map.insert(key, Entry { value, seen: now });
        Ok(expired)
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        self.map.remove(key).map(|e| e.value)
    }

    /// Remove and return every flow idle for longer than the timeout.
    pub fn sweep(&mut self, now: Instant) -> Vec<(K, V)> {
        let Some(idle) = self.idle else {
            return Vec::new();
        };
        let stale: Vec<K> = self
            .map
            .iter()
            .filter(|(_, e)| now.saturating_duration_since(e.seen) > idle)
            .map(|(k, _)| k.clone())
            .collect();
        stale
            .into_iter()
            .filter_map(|k| self.map.remove(&k).map(|e| (k, e.value)))
            .collect()
    }
}

/// Hands out local ports for flows the daemon opens on its tunnel address, from
/// the dynamic range, never one in use.
pub struct PortPool {
    next: u16,
    used: std::collections::HashSet<u16>,
}

pub const FIRST_DYNAMIC_PORT: u16 = 49152;

impl Default for PortPool {
    fn default() -> Self {
        PortPool {
            next: FIRST_DYNAMIC_PORT,
            used: Default::default(),
        }
    }
}

impl PortPool {
    pub fn take(&mut self) -> Option<u16> {
        let span = usize::from(u16::MAX - FIRST_DYNAMIC_PORT) + 1;
        for _ in 0..span {
            let port = self.next;
            self.next = if self.next == u16::MAX {
                FIRST_DYNAMIC_PORT
            } else {
                self.next + 1
            };
            if self.used.insert(port) {
                return Some(port);
            }
        }
        None
    }

    /// Never hand out `port`: something configured listens on it.
    pub fn reserve(&mut self, port: u16) {
        self.used.insert(port);
    }

    pub fn give_back(&mut self, port: u16) {
        self.used.remove(&port);
    }

    pub fn in_use(&self) -> usize {
        self.used.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// With no inactivity timeout nothing ever expires, so a full table makes
    /// room by dropping the session idle the longest instead of refusing.
    #[test]
    fn without_a_timeout_the_least_recent_session_makes_room() {
        let t0 = Instant::now();
        let mut table = SessionTable::new(2, None);
        table.insert("a", 1, t0).unwrap();
        table.insert("b", 2, t0 + Duration::from_secs(1)).unwrap();
        table.touch(&"a", t0 + Duration::from_secs(2));
        let evicted = table.insert("c", 3, t0 + Duration::from_secs(3));
        assert_eq!(evicted.ok(), Some(vec![("b", 2)]));
        assert_eq!(table.get(&"a"), Some(&1));
        assert_eq!(table.get(&"c"), Some(&3));
        assert_eq!(table.len(), 2);
    }

    #[test]
    fn idle_flows_expire() {
        let t0 = Instant::now();
        let mut table = SessionTable::new(4, Some(Duration::from_secs(10)));
        table.insert("a", 1, t0).unwrap();
        table.insert("b", 2, t0).unwrap();
        assert!(table.touch(&"a", t0 + Duration::from_secs(8)).is_some());
        let gone = table.sweep(t0 + Duration::from_secs(11));
        assert_eq!(gone, vec![("b", 2)]);
        assert_eq!(table.get(&"a"), Some(&1));
        assert_eq!(table.len(), 1);
        assert!(table.sweep(t0 + Duration::from_secs(18)).is_empty());
        assert_eq!(table.sweep(t0 + Duration::from_secs(19)).len(), 1);
        assert!(table.is_empty());
    }

    #[test]
    fn cap_refuses_the_newest() {
        let t0 = Instant::now();
        let mut table = SessionTable::new(2, Some(Duration::from_secs(10)));
        table.insert(1, (), t0).unwrap();
        table.insert(2, (), t0).unwrap();
        assert!(table.insert(3, (), t0).is_err());
        // Re-inserting a key that is there is not a new flow.
        assert!(table.insert(2, (), t0).is_ok());
        // Once one has gone idle, the new flow takes its place.
        let swept = table.insert(3, (), t0 + Duration::from_secs(11)).unwrap();
        assert_eq!(swept.len(), 2);
        assert_eq!(table.len(), 1);
        assert_eq!(table.remove(&3), Some(()));
        assert_eq!(table.remove(&3), None);
    }

    #[test]
    fn no_timeout_never_sweeps() {
        let t0 = Instant::now();
        let mut table = SessionTable::new(1, None);
        table.insert(1, (), t0).unwrap();
        assert!(table.sweep(t0 + Duration::from_secs(1_000_000)).is_empty());
        let room = table.insert(2, (), t0 + Duration::from_secs(1_000_000));
        assert_eq!(room.ok(), Some(vec![(1, ())]));
        assert!(SessionTable::new(0, None).insert(1, (), t0).is_err());
        assert!(table.touch(&9, t0).is_none());
    }

    #[test]
    fn a_reserved_port_is_never_handed_out() {
        let mut pool = PortPool::default();
        pool.reserve(FIRST_DYNAMIC_PORT);
        assert_eq!(pool.take(), Some(FIRST_DYNAMIC_PORT + 1));
    }

    #[test]
    fn ports_are_unique_and_wrap() {
        let mut pool = PortPool::default();
        let first = pool.take().unwrap();
        assert_eq!(first, FIRST_DYNAMIC_PORT);
        let mut all = vec![first];
        while let Some(p) = pool.take() {
            all.push(p);
        }
        assert_eq!(all.len(), 16384);
        assert_eq!(pool.in_use(), 16384);
        pool.give_back(50000);
        assert_eq!(pool.take(), Some(50000));
        assert_eq!(pool.take(), None);
    }

    proptest! {
        #[test]
        fn never_exceeds_cap(cap in 1usize..16, ops in proptest::collection::vec((0u8..32, 0u64..30), 0..200)) {
            let t0 = Instant::now();
            let mut table = SessionTable::new(cap, Some(Duration::from_secs(5)));
            for (key, at) in ops {
                let _ = table.insert(key, (), t0 + Duration::from_secs(at));
                prop_assert!(table.len() <= cap);
            }
        }
    }
}
