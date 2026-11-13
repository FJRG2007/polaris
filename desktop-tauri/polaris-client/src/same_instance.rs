//! Whether an address typed in the servers page is a Polaris already on the list
//! under another name - `polaris.local` next to `polaris.example.com`.
//!
//! The Rust twin of `desktop/src/main/same-instance.ts`. Settled by the
//! instance's signature (`instance::find_same_instance`), never by the name.
//!
//! Asked even when the address's certificate is one this computer does not
//! trust, since that is exactly the case of a Polaris on its local name. Those
//! requests go through a client of their own that accepts the certificate of that
//! one host (`local_ca_pin::AcceptHost`), built for the one question and dropped
//! after it. Nothing of the person's goes there: no cookie, no API key, only the
//! public describe and challenge routes, and the answer is used for the
//! comparison and nothing else. The window itself still refuses that certificate.

use crate::instance::{find_same_instance, InstanceRecord, KnownInstance};
use crate::local_ca_pin::AcceptHost;
use crate::servers::SavedServer;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an answer is reused, so typing the address again asks nothing.
const CACHE: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_ENTRIES: usize = 50;

struct Held {
    key: String,
    same: Option<String>,
    until: Instant,
}

/// The answers of the last 30 seconds.
#[derive(Default)]
pub struct SameInstance {
    memory: Mutex<VecDeque<Held>>,
}

impl SameInstance {
    /// The listed server `origin` proves it is, or `None`. `untrusted` says the
    /// address answered with a certificate this computer does not trust.
    /// `known_instance` is what each listed server said about itself (kept on
    /// disk, or asked over its own address).
    pub async fn same_instance_as<F, Fut>(
        &self,
        origin: &str,
        saved: &[SavedServer],
        untrusted: bool,
        client: &reqwest::Client,
        known_instance: F,
    ) -> Option<String>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Option<InstanceRecord>>,
    {
        let others: Vec<&SavedServer> = saved
            .iter()
            .filter(|server| server.origin != origin)
            .collect();
        let mut key = vec![origin, if untrusted { "untrusted" } else { "trusted" }];
        key.extend(others.iter().map(|server| server.origin.as_str()));
        let key = key.join(" ");
        if let Some(held) = self
            .memory()
            .iter()
            .find(|held| held.key == key && held.until > Instant::now())
        {
            return held.same.clone();
        }
        let mut known = Vec::new();
        for server in &others {
            if let Some(record) = known_instance(server.origin.clone()).await {
                known.push(KnownInstance {
                    origin: server.origin.clone(),
                    record,
                });
            }
        }
        let candidates = [origin.to_owned()];
        let same = if untrusted {
            let host = url::Url::parse(origin)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))?;
            let accepting = AcceptHost::client(&host, reqwest::Client::builder()).ok()?;
            find_same_instance(&accepting, &candidates, &known, TIMEOUT).await
        } else {
            find_same_instance(client, &candidates, &known, TIMEOUT).await
        }
        .map(|found| found.origin);
        let mut memory = self.memory();
        memory.retain(|held| held.key != key);
        if memory.len() >= CACHE_ENTRIES {
            memory.pop_front();
        }
        memory.push_back(Held {
            key,
            same: same.clone(),
            until: Instant::now() + CACHE,
        });
        same
    }

    fn memory(&self) -> std::sync::MutexGuard<'_, VecDeque<Held>> {
        self.memory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
