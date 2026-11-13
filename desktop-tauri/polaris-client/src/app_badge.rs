//! What is waiting, on the app's own icon: the taskbar button on Windows, the
//! Dock on macOS, the launcher on Linux desktops that draw a count.
//!
//! Mirrors `desktop/src/main/app-badge.ts`. The dashboard decides what to show
//! and hands it here; this checks it and says what each system is told.

use crate::notice::Platform;
use base64::Engine;
use serde::{Deserialize, Deserializer};

/// A PNG drawn by the page, small: an overlay is 16 pixels on screen.
const OVERLAY_PREFIX: &str = "data:image/png;base64,";
const MAX_OVERLAY: usize = 64 * 1024;
const MAX_COUNT: u32 = 100_000;
const MAX_LABEL: usize = 4;

/// Required but nullable, as the Electron schema has it: a missing field is
/// refused rather than read as null.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}

/// What the page hands over.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AppBadge {
    /// What a count badge reads ("3", "9+"); null for a dot or nothing.
    #[serde(deserialize_with = "nullable")]
    pub label: Option<String>,
    pub dot: bool,
    /// How many are waiting, for the systems that take a number.
    pub count: u32,
    /// The picture for the Windows taskbar, or null to take it off.
    #[serde(deserialize_with = "nullable")]
    pub overlay: Option<String>,
}

impl AppBadge {
    /// The badge with its label trimmed, or why it is refused.
    pub fn checked(mut self) -> Result<Self, &'static str> {
        if let Some(label) = &self.label {
            let label = label.trim().to_owned();
            if label.chars().count() > MAX_LABEL {
                return Err("A badge label is at most 4 characters.");
            }
            self.label = Some(label);
        }
        if self.count > MAX_COUNT {
            return Err("A badge count is at most 100000.");
        }
        if let Some(overlay) = &self.overlay {
            let data = overlay.strip_prefix(OVERLAY_PREFIX).unwrap_or("");
            let shaped = !data.is_empty()
                && data
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
            if overlay.len() > MAX_OVERLAY || !shaped {
                return Err("A badge picture is a small PNG drawn by the page.");
            }
        }
        Ok(self)
    }
}

/// What one system is told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BadgePlan {
    /// Windows: a picture over the taskbar button (none takes it off), and the
    /// label read out for it.
    Overlay { png: Option<Vec<u8>>, label: String },
    /// macOS: text on the Dock icon; none takes it off.
    Dock(Option<String>),
    /// Linux: a number, where the desktop draws one; none (zero) takes it off.
    Count(Option<u32>),
}

/// What `platform` is told for `badge`, already checked.
pub fn badge_plan(badge: &AppBadge, platform: Platform) -> BadgePlan {
    let showing = badge.dot || badge.label.is_some();
    match platform {
        Platform::Windows => {
            let png = badge
                .overlay
                .as_deref()
                .filter(|_| showing)
                .and_then(|overlay| overlay.strip_prefix(OVERLAY_PREFIX))
                .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
                .filter(|bytes| !bytes.is_empty());
            BadgePlan::Overlay {
                png,
                label: badge.label.clone().unwrap_or_default(),
            }
        }
        Platform::Mac => BadgePlan::Dock(
            showing.then(|| badge.label.clone().unwrap_or_else(|| "\u{2022}".to_owned())),
        ),
        Platform::Linux => {
            BadgePlan::Count((showing && !badge.dot && badge.count > 0).then_some(badge.count))
        }
    }
}
