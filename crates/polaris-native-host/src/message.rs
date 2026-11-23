//! What may pass through: who called, the one message the extension may send,
//! and the replies it may get back. The desktop app validates all of it again
//! with its own schema; this side only refuses what is plainly not a pairing.

use serde_json::{json, Value};

/// The extension that started this host, as the browser named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// Chrome, Chromium, Edge and Brave pass `chrome-extension://<id>/`.
    Chromium(String),
    /// Firefox passes the manifest's path, then the add-on id.
    Firefox(String),
}

impl Caller {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Chromium(id) => json!({ "browser": "chromium", "id": id }),
            Self::Firefox(id) => json!({ "browser": "firefox", "id": id }),
        }
    }
}

fn is_chromium_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// An add-on id: an email-like name or a `{uuid}`, as Firefox allows.
fn is_gecko_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 255
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@._-{}".contains(&b))
}

/// The caller from the arguments after the program name, or `None` when the
/// browser did not name one this host can recognize.
pub fn caller_from_args(args: &[String]) -> Option<Caller> {
    if let Some(origin) = args.iter().find(|a| a.starts_with("chrome-extension://")) {
        let id = origin
            .trim_start_matches("chrome-extension://")
            .trim_end_matches('/');
        return is_chromium_id(id).then(|| Caller::Chromium(id.to_owned()));
    }
    match args {
        [manifest, id, ..] if manifest.ends_with(".json") && is_gecko_id(id) => {
            Some(Caller::Firefox(id.clone()))
        }
        _ => None,
    }
}

fn is_nonce(nonce: &str) -> bool {
    (32..=128).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The message for the desktop app, built only from the fields a pairing has.
pub fn pairing_for_desktop(request: &Value, caller: &Caller) -> Option<Value> {
    let object = request.as_object()?;
    if object.get("type")?.as_str()? != "pair" {
        return None;
    }
    let server = object.get("server")?.as_str()?;
    let nonce = object.get("nonce")?.as_str()?;
    let web = server.starts_with("https://") || server.starts_with("http://");
    if !web || server.len() > 2048 || !is_nonce(nonce) {
        return None;
    }
    Some(json!({ "type": "pair", "server": server, "nonce": nonce, "caller": caller.to_json() }))
}

/// Every reason the extension understands (`NativePairFailure` in `@polaris/core`).
const REASONS: [&str; 6] = [
    "no-desktop",
    "other-server",
    "signed-out",
    "refused",
    "unreachable",
    "bad-request",
];

pub fn failure(reason: &str) -> Value {
    json!({ "ok": false, "reason": reason })
}

/// The desktop's answer as the extension may see it: exactly `{ok: true}` or a
/// known failure, never anything else the socket happened to carry.
pub fn reply_for_browser(answer: &Value) -> Value {
    match answer.get("ok").and_then(Value::as_bool) {
        Some(true) => json!({ "ok": true }),
        Some(false) => {
            let reason = answer.get("reason").and_then(Value::as_str);
            failure(reason.filter(|r| REASONS.contains(r)).unwrap_or("refused"))
        }
        None => failure("refused"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abcdefghijklmnopabcdefghijklmnop";
    const NONCE: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn reads_a_chromium_origin_with_or_without_the_parent_window() {
        let origin = format!("chrome-extension://{ID}/");
        assert_eq!(
            caller_from_args(&args(&[&origin])),
            Some(Caller::Chromium(ID.into()))
        );
        assert_eq!(
            caller_from_args(&args(&[&origin, "--parent-window=0"])),
            Some(Caller::Chromium(ID.into()))
        );
    }

    #[test]
    fn reads_a_firefox_manifest_and_add_on_id() {
        let found = caller_from_args(&args(&[
            "/home/a/.mozilla/native-messaging-hosts/x.json",
            "vault@polaris.local",
        ]));
        assert_eq!(found, Some(Caller::Firefox("vault@polaris.local".into())));
    }

    #[test]
    fn refuses_an_unrecognizable_caller() {
        assert_eq!(caller_from_args(&[]), None);
        assert_eq!(
            caller_from_args(&args(&["chrome-extension://not-an-id/"])),
            None
        );
        assert_eq!(caller_from_args(&args(&["x.json", "bad id"])), None);
        assert_eq!(caller_from_args(&args(&["--something"])), None);
    }

    #[test]
    fn passes_only_the_pairing_fields_on() {
        let caller = Caller::Chromium(ID.into());
        let request = json!({ "type": "pair", "server": "https://polaris.example", "nonce": NONCE, "extra": 1 });
        let out = pairing_for_desktop(&request, &caller).unwrap();
        assert_eq!(
            out,
            json!({ "type": "pair", "server": "https://polaris.example", "nonce": NONCE, "caller": { "browser": "chromium", "id": ID } })
        );
    }

    #[test]
    fn refuses_anything_that_is_not_a_pairing() {
        let caller = Caller::Firefox("vault@polaris.local".into());
        for bad in [
            json!(null),
            json!([]),
            json!({ "type": "other", "server": "https://a.example", "nonce": NONCE }),
            json!({ "type": "pair", "server": "file:///etc", "nonce": NONCE }),
            json!({ "type": "pair", "server": "https://a.example", "nonce": "short" }),
            json!({ "type": "pair", "server": "https://a.example", "nonce": format!("{NONCE}!") }),
            json!({ "type": "pair", "server": "https://a.example" }),
        ] {
            assert_eq!(pairing_for_desktop(&bad, &caller), None, "{bad}");
        }
    }

    #[test]
    fn hands_the_browser_only_known_replies() {
        assert_eq!(
            reply_for_browser(&json!({ "ok": true, "secret": 1 })),
            json!({ "ok": true })
        );
        assert_eq!(
            reply_for_browser(&json!({ "ok": false, "reason": "signed-out" })),
            failure("signed-out")
        );
        assert_eq!(
            reply_for_browser(&json!({ "ok": false, "reason": "/etc/passwd" })),
            failure("refused")
        );
        assert_eq!(reply_for_browser(&json!("x")), failure("refused"));
    }
}
