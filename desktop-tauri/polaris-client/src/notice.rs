//! How a notice is worded and when it is dropped, for every system.
//!
//! Mirrors `desktop/src/main/notice-layout.ts` and `notice-once.ts`. Pure, so
//! the shell only hands the words to the system.

use std::collections::HashMap;

/// The system a notice or a badge is drawn on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    /// The system this build runs on. Anything not macOS or Windows is drawn
    /// the way Linux desktops draw it.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// The longest title the system is handed: Windows cuts a toast's title at about
/// one line anyway, and a longer one only pushes the body off the notice.
const TITLE_MAX: usize = 120;

/// What the page asked to say.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NoticeWords {
    pub title: String,
    /// Where it was said - a conversation, "Mail" - under the title.
    pub subtitle: Option<String>,
    pub body: Option<String>,
}

/// What the system is handed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoticeLayout {
    pub title: String,
    /// Only macOS draws a second line.
    pub subtitle: Option<String>,
    pub body: String,
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max - 3).collect();
    format!("{}...", kept.trim_end())
}

/// Who it is from is the title, and where it was said is the line under it on
/// macOS and beside the title elsewhere, the way Element and Signal desktop
/// name the room beside the sender.
pub fn notice_layout(words: &NoticeWords, platform: Platform) -> NoticeLayout {
    let title = words.title.trim();
    let subtitle = words.subtitle.as_deref().map(str::trim).unwrap_or("");
    let body = words.body.clone().unwrap_or_default();
    if subtitle.is_empty() || subtitle == title {
        return NoticeLayout {
            title: clip(title, TITLE_MAX),
            subtitle: None,
            body,
        };
    }
    if platform == Platform::Mac {
        return NoticeLayout {
            title: clip(title, TITLE_MAX),
            subtitle: Some(clip(subtitle, TITLE_MAX)),
            body,
        };
    }
    NoticeLayout {
        title: clip(&format!("{title} - {subtitle}"), TITLE_MAX),
        subtitle: None,
        body,
    }
}

/// The picture types a notice's icon may be.
pub const ICON_TYPES: [&str; 2] = ["image/png", "image/jpeg"];

/// The picture types a notice asks the Polaris for: a stored WebP or GIF face
/// is then answered as a PNG instead of a picture this cannot draw.
pub const ICON_ACCEPT: &str = "image/png, image/jpeg";

/// The largest avatar Polaris stores (`MAX_AVATAR_BYTES`); anything bigger is
/// not an avatar.
pub const ICON_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Whether a fetched picture may be a notice's icon.
pub fn icon_acceptable(content_type: Option<&str>, size: u64) -> bool {
    let kind = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ICON_TYPES.contains(&kind.as_str()) && size > 0 && size <= ICON_MAX_BYTES
}

/// How long the words of a `once` notice wait for the other announcer's.
pub const ONCE_MS: u64 = 2 * 60_000;

/// Which `once` notices are the second announcement of something already shown.
///
/// The announcer is the part of a notice's tag before its first colon:
/// `deploy:<deployment>` for a push window, `notification:<alert>` for the
/// dashboard's feed. A notice is a repeat only when the other announcer said the
/// same words a moment ago, and that match is spent on it. The same words from
/// the same announcer are another event, and so is a third notice after a pair.
#[derive(Debug, Default)]
pub struct OnceNotices {
    said: HashMap<String, (String, u64)>,
}

impl OnceNotices {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether this notice repeats one just shown, remembering it when it does
    /// not. `now` is in milliseconds on a clock that only goes forward.
    pub fn repeated(&mut self, tag: &str, words: &str, now: u64) -> bool {
        self.said
            .retain(|_, (_, at)| now.saturating_sub(*at) <= ONCE_MS);
        let announcer = tag.split(':').next().unwrap_or(tag).to_owned();
        if let Some((earlier, _)) = self.said.get(words) {
            if *earlier != announcer {
                self.said.remove(words);
                return true;
            }
        }
        self.said.insert(words.to_owned(), (announcer, now));
        false
    }
}
