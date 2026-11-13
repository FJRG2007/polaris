//! Which browser permissions a window is given. Pure, for the tests.
//!
//! The Rust twin of `desktop/src/main/permissions.ts`. Deny by default, and only
//! ever for the configured Polaris - never for a page in a frame it embeds, or
//! for anything else that ends up in a window:
//!
//! - `notifications` - the dashboard's own notices (calls, messages, mail).
//! - `clipboard-read`, `clipboard-sanitized-write` - copy and paste buttons.
//! - `media` - the microphone and camera, which a call cannot work without.
//! - `fullscreen` - a video or a call's stage, full screen.
//! - `display-capture` - sharing a screen or a window in a call.

const GRANTED: [&str; 6] = [
    "notifications",
    "clipboard-read",
    "clipboard-sanitized-write",
    "media",
    "fullscreen",
    "display-capture",
];

/// What the app's own pages are given, which is only ever one thing: the camera
/// to the settings window, to read a QR of hosts off another device. Video and
/// nothing else - never the microphone - and no other page of ours.
pub fn allow_local_permission(
    permission: &str,
    kind: Option<&str>,
    media_types: Option<&[&str]>,
) -> bool {
    if permission != "media" || kind != Some("connect") {
        return false;
    }
    media_types.is_none_or(|types| !types.is_empty() && types.iter().all(|kind| *kind == "video"))
}

pub fn allow_permission(
    permission: &str,
    requesting_url: &str,
    server_origin: Option<&str>,
) -> bool {
    let Some(server_origin) = server_origin else {
        return false;
    };
    GRANTED.contains(&permission)
        && url::Url::parse(requesting_url)
            .is_ok_and(|url| url.origin().ascii_serialization() == server_origin)
}
