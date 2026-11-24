//! Matching for the settings search box.
//!
//! Every word of a query has to match a widget's searchable text: its `search_terms` plus the
//! labels it sits under (page, sidebar group, category). A word matches in one of two modes:
//!
//! - [`MatchMode::Exact`]: the word is a case-insensitive substring of the text, or its singular
//!   form starts one of the text's words ("aliases" finds "alias"). Labels are stricter: the word
//!   itself has to start one of their words too.
//! - [`MatchMode::Fuzzy`]: additionally tolerates typos ("opacty") and abbreviations ("ntf").
//!
//! The settings view searches in exact mode first and retries in fuzzy mode only when nothing
//! matched, so a query that already finds something never gains near-miss results.

use strsim::osa_distance;

/// Words shorter than this are never matched by abbreviation: two letters start too many terms
/// to mean anything.
const MIN_ABBREVIATION_LEN: usize = 3;

/// Words shorter than this must be spelled exactly; one typo in three letters is most of the word.
const MIN_TYPO_LEN: usize = 4;

/// Words at least this long tolerate two typos instead of one.
const TWO_TYPO_LEN: usize = 8;

/// The shortest singular form tried for a plural, so "bus" is not searched as "bu".
const MIN_STEM_LEN: usize = 3;

/// Where in the text a word may be found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Anchor {
    Anywhere,
    WordStart,
}

/// How forgiving a [`SearchQuery`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MatchMode {
    Exact,
    Fuzzy,
}

/// A settings search query, lowercased and split into words once per keystroke rather than once
/// per widget.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SearchQuery {
    words: Vec<String>,
    mode: MatchMode,
}

impl SearchQuery {
    pub(crate) fn new(text: &str, mode: MatchMode) -> Self {
        Self {
            words: text.split_whitespace().map(str::to_lowercase).collect(),
            mode,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// The same words, matched with typo and abbreviation tolerance.
    pub(crate) fn fuzzy(&self) -> Self {
        Self {
            words: self.words.clone(),
            mode: MatchMode::Fuzzy,
        }
    }

    /// Drops the words that `label` already matches. Used for the page, sidebar group and
    /// category names a widget sits under: a word naming the page holds for every widget on it,
    /// so "appearance opacity" finds the opacity setting on the Appearance page, and
    /// "appearance" alone shows that whole page. Since a consumed word reveals every widget
    /// under the label, it has to start one of the label's words: "count" does not show all of
    /// Account.
    pub(crate) fn without_words_matching(&self, label: &str) -> Self {
        let text = SearchText::new(label);
        let words = self
            .words
            .iter()
            .filter(|word| !self.word_matches(word, &text, Anchor::WordStart))
            .cloned()
            .collect();
        Self {
            words,
            mode: self.mode,
        }
    }

    /// Whether every word of the query matches `terms`. An empty query matches everything.
    pub(crate) fn matches(&self, terms: &str) -> bool {
        let text = SearchText::new(terms);
        self.words
            .iter()
            .all(|w| self.word_matches(w, &text, Anchor::Anywhere))
    }

    fn word_matches(&self, word: &str, text: &SearchText, anchor: Anchor) -> bool {
        if text.contains_exact(word, anchor) {
            return true;
        }
        self.mode == MatchMode::Fuzzy && text.tokens().any(|token| is_near_miss(word, token))
    }
}

/// Lowercased text to match query words against.
struct SearchText {
    text: String,
}

impl SearchText {
    fn new(text: &str) -> Self {
        Self {
            text: text.to_lowercase(),
        }
    }

    /// The words of the text, split on anything that is not a letter or digit so "re-arrange"
    /// and "a.i." yield their parts.
    fn tokens(&self) -> impl Iterator<Item = &str> {
        self.text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|token| !token.is_empty())
    }

    fn contains_exact(&self, word: &str, anchor: Anchor) -> bool {
        let found = match anchor {
            Anchor::Anywhere => self.text.contains(word),
            Anchor::WordStart => self.has_word_starting_with(word),
        };
        // A plural finds its singular, but only at the start of a word: a shortened stem found
        // mid-word ("tab" in "stability") is noise.
        found || singulars(word).any(|s| self.has_word_starting_with(s))
    }

    /// Whether `prefix` occurs where a word of the text starts, i.e. not right after a letter or
    /// digit.
    fn has_word_starting_with(&self, prefix: &str) -> bool {
        let mut previous: Option<char> = None;
        self.text.char_indices().any(|(i, c)| {
            let at_word_start = !previous.is_some_and(char::is_alphanumeric);
            previous = Some(c);
            at_word_start && self.text[i..].starts_with(prefix)
        })
    }
}

/// The singular forms `word` may have if it is a plural, long enough to be worth searching for.
/// "es" is only stripped after a sibilant ("aliases", "boxes", "patches"); elsewhere it belongs to
/// the singular, and "files" searched as "fil" would find "filter".
fn singulars(word: &str) -> impl Iterator<Item = &str> {
    let without_es = word.strip_suffix("es").filter(|stem| {
        ["s", "x", "z", "ch", "sh"]
            .iter()
            .any(|end| stem.ends_with(end))
    });
    let without_s = word.strip_suffix('s');
    [without_es, without_s]
        .into_iter()
        .flatten()
        .filter(|stem| stem.chars().count() >= MIN_STEM_LEN)
}

/// Whether `word` is a misspelling or an abbreviation of `token`.
fn is_near_miss(word: &str, token: &str) -> bool {
    within_typos(word, token) || abbreviates(word, token)
}

/// Whether `word` is `token`, or the start of it while the user is still typing, with at most a
/// couple of typos. A typo is an inserted, missing, replaced or swapped character.
fn within_typos(word: &str, token: &str) -> bool {
    let word_len = word.chars().count();
    if word_len < MIN_TYPO_LEN {
        return false;
    }
    let max_typos = if word_len < TWO_TYPO_LEN { 1 } else { 2 };
    if osa_distance(word, token) <= max_typos {
        return true;
    }
    // A partly typed word is compared with the token's first characters. The prefix is also
    // tried a character shorter and longer, to absorb a doubled or missing letter.
    [word_len - 1, word_len, word_len + 1]
        .into_iter()
        .filter_map(|len| proper_prefix(token, len))
        .any(|prefix| osa_distance(word, prefix) <= max_typos)
}

/// The first `len` characters of `token`, when it has more than that.
fn proper_prefix(token: &str, len: usize) -> Option<&str> {
    let (end, _) = token.char_indices().nth(len)?;
    Some(&token[..end])
}

/// Whether `word` abbreviates `token`: both start with the same character and the word's
/// characters appear in order within the first `2 * len` characters of the token, as "ntf" does
/// in "notifications". The bound keeps a short word from matching scattered letters of a long
/// one.
fn abbreviates(word: &str, token: &str) -> bool {
    let word_len = word.chars().count();
    if word_len < MIN_ABBREVIATION_LEN || word.chars().next() != token.chars().next() {
        return false;
    }
    let mut remaining = word.chars().peekable();
    for ch in token.chars().take(2 * word_len) {
        if remaining.peek() == Some(&ch) {
            remaining.next();
            if remaining.peek().is_none() {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
