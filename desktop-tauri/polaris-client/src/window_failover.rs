//! When the main window goes to the same Polaris on its local address, and when
//! it comes back. Pure, so the rules are tested without a webview.
//!
//! The Rust twin of `desktop/src/main/window-failover.ts`. The address itself is
//! picked by the failover in `instance`: an alternate is used only after it
//! signed a fresh challenge with the instance key learned over the usual address,
//! and only over TLS this computer trusts. Nothing here accepts a certificate.
//!
//! Failed loads are named with Chromium's codes (`ERR_NAME_NOT_RESOLVED`), which
//! the shell maps WebView2's `COREWEBVIEW2_WEB_ERROR_STATUS` onto.

use crate::navigation::is_server_url;

/// Chromium's codes for an address that did not answer at all.
const UNANSWERED: [&str; 14] = [
    "ERR_NAME_NOT_RESOLVED",
    "ERR_NAME_RESOLUTION_FAILED",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NETWORK_CHANGED",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_CONNECTION_FAILED",
    "ERR_CONNECTION_TIMED_OUT",
    "ERR_TIMED_OUT",
    "ERR_ADDRESS_UNREACHABLE",
    "ERR_NETWORK_UNREACHABLE",
    "ERR_PROXY_CONNECTION_FAILED",
    "ERR_TUNNEL_CONNECTION_FAILED",
];

/// The first `ERR_[A-Z0-9_]+` in a text (`netErrorCode` in `reachability.ts`).
pub fn net_error_code(text: &str) -> Option<&str> {
    let mut from = 0;
    while let Some(found) = text[from..].find("ERR_") {
        let start = from + found;
        let rest = &text[start + 4..];
        let length = rest
            .find(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
            .unwrap_or(rest.len());
        if length > 0 {
            return Some(&text[start..start + 4 + length]);
        }
        from = start + 4;
    }
    None
}

/// Whether a Chromium error code is a certificate this computer does not trust.
pub fn is_certificate_error(code: Option<&str>) -> bool {
    code.is_some_and(|code| {
        code.starts_with("ERR_CERT_")
            || code == "ERR_SSL_PROTOCOL_ERROR"
            || code == "ERR_BAD_SSL_CLIENT_AUTH_CERT"
    })
}

/// Whether a failed load is the address not answering, which another address of
/// the same Polaris may get around. A certificate error is not: that address did
/// answer, with something this computer does not trust.
pub fn triggers_failover(code: Option<&str>) -> bool {
    !is_certificate_error(code) && code.is_some_and(|code| UNANSWERED.contains(&code))
}

/// What to do with a failed load of the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailedLoad {
    Ignore,
    Failover,
    Error,
}

/// A failed load of the main frame, given the origin the window is on now.
/// -3 is a load another one replaced (a redirect, a click): nothing wrong.
pub fn failed_load_step(code: i32, description: &str, url: &str, active: &str) -> FailedLoad {
    if code == -3 || !is_server_url(url, active) {
        return FailedLoad::Ignore;
    }
    if triggers_failover(net_error_code(description)) {
        FailedLoad::Failover
    } else {
        FailedLoad::Error
    }
}

/// The same place - path, query and hash - on `origin`, or `None` for a URL that
/// cannot be read. Moves only within the one Polaris: the caller passes an
/// origin the failover proved.
pub fn same_place_on(url: &str, origin: &str) -> Option<String> {
    let from = url::Url::parse(url).ok()?;
    let to = url::Url::parse(origin).ok()?;
    let web = |url: &url::Url| matches!(url.scheme(), "http" | "https");
    if !web(&from) || !web(&to) {
        return None;
    }
    // `URL.search` and `URL.hash` are empty for an empty query or fragment.
    let query = from
        .query()
        .filter(|query| !query.is_empty())
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let hash = from
        .fragment()
        .filter(|fragment| !fragment.is_empty())
        .map(|fragment| format!("#{fragment}"))
        .unwrap_or_default();
    Some(format!(
        "{}{}{query}{hash}",
        to.origin().ascii_serialization(),
        from.path()
    ))
}

/// The one origin Polaris windows may be on: the proven alternate while the
/// window is on it, otherwise the usual address. Never both.
pub fn active_origin<'a>(primary: Option<&'a str>, alternate: Option<&'a str>) -> Option<&'a str> {
    primary?;
    alternate.or(primary)
}

/// What a recheck of the usual address means for a window on an alternate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackStep {
    Stay,
    Now,
    OnBlur,
}

/// Back to the usual address when it answers: at once when the window is not in
/// use, otherwise as soon as the person leaves it, so a form being typed is not
/// reloaded under them.
pub fn back_step(resolved: &str, primary: &str, focused: bool) -> BackStep {
    if resolved != primary {
        BackStep::Stay
    } else if focused {
        BackStep::OnBlur
    } else {
        BackStep::Now
    }
}

/// The window title while on an alternate: the page's own, then the words.
pub fn title_with(title: &str, words: Option<&str>) -> String {
    let Some(words) = words else {
        return title.to_owned();
    };
    let base = title.trim();
    if base.is_empty() {
        words.to_owned()
    } else {
        format!("{base} - {words}")
    }
}
