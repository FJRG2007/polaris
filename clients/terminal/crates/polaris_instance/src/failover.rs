//! The address-picking state for one terminal and one instance, without I/O:
//! the caller sends the requests and reports what happened (`createFailover` in
//! the TypeScript module, split so any HTTP client can drive it).
//!
//! Order on every request: the address it is holding (if the hold has not run
//! out), then the primary, then each alternate. An alternate is used only while
//! it is verified; a network failure or a gateway status moves on to the next,
//! and any real answer, a 401 included, ends the walk. Once the hold runs out
//! the primary is tried first again, so the terminal goes back to it as soon as
//! it answers. Times are milliseconds on any monotonic clock.

use std::collections::{BTreeSet, HashMap};

use crate::{AlternateVerdict, DEFAULT_HOLD_MS, DEFAULT_VERIFIED_MS, InstanceRecord};

#[derive(Clone, Debug)]
pub struct FailoverState {
    primary: String,
    instance: Option<InstanceRecord>,
    alternates: Vec<String>,
    current: String,
    held_until: u64,
    verified_until: HashMap<String, u64>,
    refused: BTreeSet<String>,
    untrusted: BTreeSet<String>,
}

impl FailoverState {
    pub fn new(primary: &str, instance: Option<InstanceRecord>) -> Self {
        let primary =
            crate::read_origin(primary).unwrap_or_else(|| primary.trim_end_matches('/').to_owned());
        let alternates = instance
            .as_ref()
            .map(|record| {
                record
                    .addresses
                    .iter()
                    .filter(|origin| **origin != primary)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Self {
            current: primary.clone(),
            primary,
            instance,
            alternates,
            held_until: 0,
            verified_until: HashMap::new(),
            refused: BTreeSet::new(),
            untrusted: BTreeSet::new(),
        }
    }

    pub fn primary(&self) -> &str {
        &self.primary
    }

    pub fn instance(&self) -> Option<&InstanceRecord> {
        self.instance.as_ref()
    }

    /// The origins to try, in order.
    pub fn order(&self, now: u64) -> Vec<String> {
        let mut order = Vec::new();
        if self.current != self.primary && self.held_until > now {
            order.push(self.current.clone());
        }
        for origin in std::iter::once(&self.primary).chain(&self.alternates) {
            if !order.contains(origin) {
                order.push(origin.clone());
            }
        }
        order
    }

    /// Whether `origin` may receive the credential now without a new challenge.
    pub fn is_verified(&self, origin: &str, now: u64) -> bool {
        origin == self.primary
            || self
                .verified_until
                .get(origin)
                .is_some_and(|until| *until > now)
    }

    /// Records what challenging an alternate found.
    pub fn record_verdict(&mut self, origin: &str, verdict: AlternateVerdict, now: u64) {
        match verdict {
            AlternateVerdict::Same => {
                self.verified_until
                    .insert(origin.to_owned(), now + DEFAULT_VERIFIED_MS);
                self.refused.remove(origin);
                self.untrusted.remove(origin);
            }
            AlternateVerdict::Different => {
                self.verified_until.remove(origin);
                self.refused.insert(origin.to_owned());
            }
            AlternateVerdict::Unreachable { certificate } => {
                self.verified_until.remove(origin);
                if certificate {
                    self.untrusted.insert(origin.to_owned());
                } else {
                    self.untrusted.remove(origin);
                }
            }
        }
    }

    /// An origin failed (no answer, or a gateway status): an alternate must
    /// prove itself again before it is used.
    pub fn record_failure(&mut self, origin: &str) {
        if origin != self.primary {
            self.verified_until.remove(origin);
        }
    }

    /// An origin answered: hold on to it, or go back to the primary.
    pub fn settle(&mut self, origin: &str, now: u64) {
        if origin == self.primary {
            self.current = self.primary.clone();
            self.held_until = 0;
        } else if origin != self.current || self.held_until <= now {
            self.current = origin.to_owned();
            self.held_until = now + DEFAULT_HOLD_MS;
        }
    }

    /// The origin the last answer came from.
    pub fn current(&self) -> &str {
        &self.current
    }

    /// Whether the terminal is on an alternate rather than the address it was given.
    pub fn is_local(&self) -> bool {
        self.current != self.primary
    }

    /// Alternates that answered as a different Polaris and were never sent the credential.
    pub fn refused(&self) -> impl Iterator<Item = &str> {
        self.refused.iter().map(String::as_str)
    }

    /// Alternates the terminal could not open because it does not trust their certificate.
    pub fn untrusted(&self) -> impl Iterator<Item = &str> {
        self.untrusted.iter().map(String::as_str)
    }
}
