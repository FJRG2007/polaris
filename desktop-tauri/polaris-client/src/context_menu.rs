//! The right-click menu: what it offers for a link, a selection or a text field.
//!
//! Mirrors `desktop/src/main/context-menu.ts`. Pure: a shell that is told what
//! was right-clicked builds its menu from this.

use url::Url;

/// What was right-clicked.
#[derive(Clone, Debug, Default)]
pub struct MenuParams {
    pub link_url: String,
    pub selection_text: String,
    pub is_editable: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub can_cut: bool,
    pub can_copy: bool,
    pub can_paste: bool,
    pub can_select_all: bool,
    pub misspelled_word: String,
    pub dictionary_suggestions: Vec<String>,
}

/// An editing command the engine itself carries out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditRole {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

/// One line of the menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContextItem {
    /// Replace the misspelled word with this one.
    Replace(String),
    /// Hand this link to the system's browser or mail client.
    OpenExternal {
        label: &'static str,
        url: String,
    },
    /// Put this text on the clipboard.
    CopyText {
        label: &'static str,
        text: String,
    },
    Role {
        role: EditRole,
        enabled: bool,
    },
    Separator,
}

/// Only these leave the app for the system's browser or mail client.
pub fn openable_link(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    matches!(parsed.scheme(), "http" | "https" | "mailto").then(|| parsed.to_string())
}

/// The menu for one right-click; empty when there is nothing to offer.
pub fn context_menu_items(params: &MenuParams) -> Vec<ContextItem> {
    let mut groups: Vec<Vec<ContextItem>> = Vec::new();
    if params.is_editable && !params.misspelled_word.is_empty() {
        let suggestions: Vec<ContextItem> = params
            .dictionary_suggestions
            .iter()
            .take(5)
            .map(|word| ContextItem::Replace(word.clone()))
            .collect();
        if !suggestions.is_empty() {
            groups.push(suggestions);
        }
    }
    let link = (!params.link_url.is_empty())
        .then(|| openable_link(&params.link_url))
        .flatten();
    if let Some(link) = link {
        let mail = link.starts_with("mailto:");
        let address = link.strip_prefix("mailto:").unwrap_or(&link).to_owned();
        groups.push(vec![
            ContextItem::OpenExternal {
                label: if mail {
                    "Send email"
                } else {
                    "Open link in browser"
                },
                url: link.clone(),
            },
            ContextItem::CopyText {
                label: if mail {
                    "Copy email address"
                } else {
                    "Copy link"
                },
                text: address,
            },
        ]);
    }
    let role = |role, enabled| ContextItem::Role { role, enabled };
    if params.is_editable {
        groups.push(vec![
            role(EditRole::Undo, params.can_undo),
            role(EditRole::Redo, params.can_redo),
        ]);
        groups.push(vec![
            role(EditRole::Cut, params.can_cut),
            role(EditRole::Copy, params.can_copy),
            role(EditRole::Paste, params.can_paste),
            role(EditRole::SelectAll, params.can_select_all),
        ]);
    } else if !params.selection_text.trim().is_empty() {
        groups.push(vec![role(EditRole::Copy, true)]);
    }
    let mut items = Vec::new();
    for (index, group) in groups.into_iter().enumerate() {
        if index > 0 {
            items.push(ContextItem::Separator);
        }
        items.extend(group);
    }
    items
}
