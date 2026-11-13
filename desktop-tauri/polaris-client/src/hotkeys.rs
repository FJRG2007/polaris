//! The call's keys - mute and deafen - held by the operating system while a
//! call is on, so they work with another program in front.
//!
//! Mirrors `desktop/src/shared/call-hotkeys.ts`. The dashboard sends its
//! bindings in its own spelling (`F9`, `Mod+Shift+m`); this turns each into an
//! accelerator, or refuses it. A key held system-wide is taken from every other
//! program, so only a press nobody types is accepted: a function key, alone or
//! with modifiers, or any key with Ctrl, Cmd or Alt held.

use serde::Deserialize;

/// The most keys one control may hold, as the dashboard caps them.
const MAX_KEYS: usize = 4;
/// The longest binding the page may send.
const MAX_BINDING: usize = 40;

/// The two controls a call key can be for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallHotkey {
    Mic,
    Deafen,
}

/// The page's bindings; `null` instead of this lets the keys go.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CallHotkeys {
    pub mic: Vec<String>,
    pub deafen: Vec<String>,
}

impl CallHotkeys {
    /// Refuses lists longer than the dashboard allows and overlong bindings.
    pub fn checked(self) -> Result<Self, &'static str> {
        for list in [&self.mic, &self.deafen] {
            if list.len() > MAX_KEYS {
                return Err("A call control holds at most 4 keys.");
            }
            if list
                .iter()
                .any(|one| one.encode_utf16().count() > MAX_BINDING)
            {
                return Err("That is not a key binding.");
            }
        }
        Ok(self)
    }
}

/// Which controls the system took, each false when none of its keys could be.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct CallHotkeysResult {
    pub mic: bool,
    pub deafen: bool,
}

const NAMED: [(&str, &str); 14] = [
    ("Enter", "Enter"),
    ("Escape", "Esc"),
    ("Delete", "Delete"),
    ("Backspace", "Backspace"),
    ("Space", "Space"),
    ("ArrowUp", "Up"),
    ("ArrowDown", "Down"),
    ("ArrowLeft", "Left"),
    ("ArrowRight", "Right"),
    ("Home", "Home"),
    ("End", "End"),
    ("PageUp", "PageUp"),
    ("PageDown", "PageDown"),
    ("Insert", "Insert"),
];

/// `F1` to `F24`, as the number.
fn function_key(token: &str) -> Option<u8> {
    let digits = token.strip_prefix('F')?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|n| (1..=24).contains(n))
}

/// A dashboard binding as an accelerator, or `None` when it cannot be one or is
/// not safe to take from every other program.
pub fn to_accelerator(binding: &str) -> Option<String> {
    let text = binding.trim();
    if text.is_empty() {
        return None;
    }
    let plus = text == "+" || text.ends_with("++");
    let mut tokens: Vec<&str> = if plus {
        let mut head: Vec<&str> = if text == "+" {
            Vec::new()
        } else {
            text[..text.len() - 2].split('+').collect()
        };
        head.push("+");
        head
    } else {
        text.split('+').collect()
    };
    let key_token = tokens.pop().filter(|token| !token.is_empty())?;
    let (mut control, mut alt, mut shift) = (false, false, false);
    for token in tokens {
        match token.trim().to_lowercase().as_str() {
            "mod" => control = true,
            "alt" => alt = true,
            "shift" => shift = true,
            _ => return None,
        }
    }
    let function = function_key(key_token);
    let key = if let Some(number) = function {
        format!("F{number}")
    } else if let Some((_, named)) = NAMED.iter().find(|(name, _)| *name == key_token) {
        (*named).to_owned()
    } else if key_token == "+" {
        "Plus".to_owned()
    } else if key_token.len() == 1 && key_token.as_bytes()[0].is_ascii_alphanumeric() {
        key_token.to_ascii_uppercase()
    } else if key_token.chars().count() == 1 && "-=[];',./`\\".contains(key_token) {
        key_token.to_owned()
    } else {
        return None;
    };
    // Nothing anybody types: a function key, or a key with Ctrl, Cmd or Alt.
    if function.is_none() && !control && !alt {
        return None;
    }
    let mut parts = Vec::new();
    if control {
        parts.push("CommandOrControl".to_owned());
    }
    if alt {
        parts.push("Alt".to_owned());
    }
    if shift {
        parts.push("Shift".to_owned());
    }
    parts.push(key);
    Some(parts.join("+"))
}

/// Each control's accelerators in the order given, without repeats and without
/// one both controls would answer to.
pub fn call_accelerators(input: &CallHotkeys) -> Vec<(String, CallHotkey)> {
    let mut out: Vec<(String, CallHotkey)> = Vec::new();
    let mut owner: Vec<(String, CallHotkey)> = Vec::new();
    for (which, list) in [
        (CallHotkey::Mic, &input.mic),
        (CallHotkey::Deafen, &input.deafen),
    ] {
        for binding in list {
            let Some(accelerator) = to_accelerator(binding) else {
                continue;
            };
            match owner.iter().find(|(held, _)| *held == accelerator) {
                Some((_, held)) if *held == which => continue,
                Some(_) => {
                    out.retain(|(held, _)| *held != accelerator);
                    continue;
                }
                None => {}
            }
            owner.push((accelerator.clone(), which));
            out.push((accelerator, which));
        }
    }
    out
}

/// An accelerator in the spelling the system shortcut parser reads: it has no
/// `Plus`, which is the `=` key Electron holds for it.
pub fn shortcut_spelling(accelerator: &str) -> String {
    match accelerator.strip_suffix("Plus") {
        Some(head) if head.is_empty() || head.ends_with('+') => format!("{head}Equal"),
        _ => accelerator.to_owned(),
    }
}
