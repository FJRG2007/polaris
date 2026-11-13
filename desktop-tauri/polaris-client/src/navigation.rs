//! Where a window may go. Pure predicates, tested without a webview.
//!
//! The Rust twin of `desktop/src/main/navigation.ts`. Only the configured Polaris
//! is loaded in a window; every other web address is opened in the system
//! browser, and anything that is not a web address is dropped.
//!
//! One exception: a round trip to an outside provider that the Polaris itself
//! starts (linking an account, or signing in with one). From the moment the
//! Polaris sends the window out until a page of the Polaris is shown again, the
//! main frame may go anywhere on the web. The app's commands still answer only a
//! window on the Polaris (`ipc` in the shell).

use url::Url;

fn parse(url: &str) -> Option<Url> {
    Url::parse(url).ok()
}

fn is_web(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Whether a URL is on the Polaris this app opens.
pub fn is_server_url(url: &str, server_origin: &str) -> bool {
    parse(url).is_some_and(|target| {
        is_web(&target) && target.origin().ascii_serialization() == server_origin
    })
}

/// Whether a URL may be handed to the operating system: web pages, and a mail
/// link, which opens the mail app. Nothing else - a `file:` or UNC path, or a
/// custom scheme, would launch whatever the machine has registered for it.
pub fn is_safe_external_url(url: &str) -> bool {
    parse(url).is_some_and(|target| matches!(target.scheme(), "http" | "https" | "mailto"))
}

/// What to do with a navigation of the main frame, or a window it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationVerdict {
    /// The configured Polaris.
    Allow,
    /// Somewhere else on the web: cancelled here and opened in the system browser.
    External,
    /// Anything else (`data:`, `file:`, `javascript:`, unparseable).
    Block,
}

pub fn classify_navigation(url: &str, server_origin: &str) -> NavigationVerdict {
    if is_server_url(url, server_origin) {
        NavigationVerdict::Allow
    } else if is_safe_external_url(url) {
        NavigationVerdict::External
    } else {
        NavigationVerdict::Block
    }
}

/// `^/api/connections/[a-z0-9_-]+/(link|signin)$`
fn is_provider_trip_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/connections/") else {
        return false;
    };
    let Some((provider, action)) = rest.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && provider
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && matches!(action, "link" | "signin")
}

/// Whether a URL is the Polaris sending the window out to a provider.
pub fn starts_provider_trip(url: &str, server_origin: &str) -> bool {
    is_server_url(url, server_origin)
        && parse(url).is_some_and(|target| is_provider_trip_path(target.path()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MainFrameStep {
    pub verdict: NavigationVerdict,
    /// Whether the window is out on a provider's round trip after this step.
    pub trip: bool,
}

/// A navigation or redirect of the main frame, given whether the window is out on
/// a provider's round trip. A trip starts on one of the Polaris routes that begin
/// one and ends when a page of the Polaris is shown again.
pub fn main_frame_step(url: &str, server_origin: &str, trip: bool) -> MainFrameStep {
    if is_server_url(url, server_origin) {
        return MainFrameStep {
            verdict: NavigationVerdict::Allow,
            trip: trip || starts_provider_trip(url, server_origin),
        };
    }
    if trip && parse(url).is_some_and(|target| is_web(&target)) {
        return MainFrameStep {
            verdict: NavigationVerdict::Allow,
            trip,
        };
    }
    MainFrameStep {
        verdict: classify_navigation(url, server_origin),
        trip,
    }
}

/// Where Back goes from the history entry at `active`: the entry before it when
/// that is on the Polaris, or, from a page elsewhere, the last page of the
/// Polaris before it. `None` when there is nowhere to go.
pub fn back_index(urls: &[&str], active: usize, server_origin: &str) -> Option<usize> {
    let away = !is_server_url(urls.get(active).copied().unwrap_or(""), server_origin);
    for index in (0..active.min(urls.len())).rev() {
        if is_server_url(urls[index], server_origin) {
            return Some(index);
        }
        if !away {
            return None;
        }
    }
    None
}

/// A path on the Polaris, as the dashboard asks for one. The full URL, or `None`
/// for anything that is not a plain path on the same origin - `//elsewhere`, a
/// full URL, a backslash that a URL parser reads as a slash.
pub fn server_path(path: &str, server_origin: &str) -> Option<String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    let target = parse(&format!("{server_origin}{path}"))?;
    (target.origin().ascii_serialization() == server_origin).then(|| target.to_string())
}
