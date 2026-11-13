//! `polaris://open?server=<origin>&path=<path>`: a page of a Polaris, opened in
//! this app by something else on the computer, such as the Stream Deck plugin.
//!
//! The Rust twin of `desktop/src/shared/deep-link.ts` and
//! `desktop/src/main/deep-links.ts`. Any website can start such a link, so it
//! only ever names a page to show: it carries nothing, a page acts only on what
//! somebody then presses, and a page on another Polaris kept here opens only
//! after a yes.

use std::future::Future;
use std::sync::{Arc, Mutex};

pub const DEEP_LINK_SCHEME: &str = "polaris";

/// A link to open: a page of a named Polaris, or (server `None`) of the one in
/// use, which is what a mailto link asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppLink {
    pub server: Option<String>,
    pub path: String,
}

/// What a link asks for, or `None` when it is not one of ours.
pub fn read_deep_link(value: &str) -> Option<AppLink> {
    if crate::servers::utf16_len(value) > 2048 {
        return None;
    }
    let link = url::Url::parse(value).ok()?;
    if link.scheme() != DEEP_LINK_SCHEME || link.host_str() != Some("open") {
        return None;
    }
    let param = |name: &str| {
        link.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let server = url::Url::parse(&param("server").unwrap_or_default()).ok()?;
    if !matches!(server.scheme(), "https" | "http") {
        return None;
    }
    if !server.username().is_empty() || server.password().is_some() {
        return None;
    }
    let path = param("path").unwrap_or_else(|| "/".to_owned());
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    Some(AppLink {
        server: Some(server.origin().ascii_serialization()),
        path,
    })
}

/// The link among a process's arguments, which is how Windows and Linux hand it over.
pub fn deep_link_in<S: AsRef<str>>(argv: &[S]) -> Option<AppLink> {
    let prefix = format!("{DEEP_LINK_SCHEME}://");
    argv.iter()
        .map(AsRef::as_ref)
        .filter(|argument| argument.starts_with(&prefix))
        .find_map(read_deep_link)
}

/// Where a link goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepLinkRoute {
    /// The Polaris open here.
    Here,
    /// Another one kept here.
    Switch,
    /// The browser, for one this app does not know.
    Browser,
}

pub fn deep_link_route(link: &AppLink, current: Option<&str>, saved: &[String]) -> DeepLinkRoute {
    match link.server.as_deref() {
        None => DeepLinkRoute::Here,
        Some(server) if Some(server) == current => DeepLinkRoute::Here,
        Some(server) if saved.iter().any(|kept| kept == server) => DeepLinkRoute::Switch,
        Some(_) => DeepLinkRoute::Browser,
    }
}

/// What opening a link does to the app: the shell's windows and settings.
pub trait DeepLinkSteps: Send + Sync + 'static {
    fn current(&self) -> Option<String>;
    fn saved(&self) -> Vec<String>;
    /// Bring the app to the front, at a page of the Polaris in use when one is given.
    fn show(&self, path: Option<&str>);
    fn confirm_switch(&self, server: &str) -> impl Future<Output = bool> + Send;
    /// Go to a kept server; false when that failed, which the step has already said.
    fn switch_to(&self, server: &str) -> impl Future<Output = bool> + Send;
    fn open_in_browser(&self, url: &str);
}

#[derive(Default)]
struct Queue {
    waiting: Option<AppLink>,
    opened: bool,
    asking: bool,
}

/// A link that arrives before the app has opened waits for that moment; after
/// it, a link opens straight away. Going to another Polaris takes a yes from
/// whoever is at the computer, and only one question is ever open.
pub struct DeepLinks<S: DeepLinkSteps> {
    steps: S,
    queue: Mutex<Queue>,
}

impl<S: DeepLinkSteps> DeepLinks<S> {
    pub fn new(steps: S, started_for: Option<AppLink>) -> Arc<Self> {
        Arc::new(Self {
            steps,
            queue: Mutex::new(Queue {
                waiting: started_for,
                ..Queue::default()
            }),
        })
    }

    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A link has reached the app: the link to open now, or `None` while the app
    /// is opening, when it waits (the newest one wins).
    pub fn arrive(&self, link: AppLink) -> Option<AppLink> {
        let mut queue = self.queue();
        if queue.opened {
            return Some(link);
        }
        queue.waiting = Some(link);
        None
    }

    /// The app is past its start: the link that waited, to open now.
    pub fn opened(&self) -> Option<AppLink> {
        let mut queue = self.queue();
        queue.opened = true;
        queue.waiting.take()
    }

    /// Opens a link handed back by `arrive` or `opened`. Everything up to the
    /// question happens at once, so a caller sees its window.
    pub async fn open(&self, link: AppLink) {
        let route = deep_link_route(&link, self.steps.current().as_deref(), &self.steps.saved());
        let Some(server) = link.server.as_deref() else {
            self.steps.show(Some(&link.path));
            return;
        };
        match route {
            DeepLinkRoute::Browser => {
                self.steps
                    .open_in_browser(&format!("{server}{}", link.path));
                return;
            }
            DeepLinkRoute::Here => {
                self.steps.show(Some(&link.path));
                return;
            }
            DeepLinkRoute::Switch => self.steps.show(None),
        }
        {
            let mut queue = self.queue();
            if queue.asking {
                return;
            }
            queue.asking = true;
        }
        let yes = self.steps.confirm_switch(server).await;
        self.queue().asking = false;
        if yes && self.steps.switch_to(server).await {
            self.steps.show(Some(&link.path));
        }
    }
}
