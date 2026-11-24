use super::*;

fn exact(query: &str) -> SearchQuery {
    SearchQuery::new(query, MatchMode::Exact)
}

fn fuzzy(query: &str) -> SearchQuery {
    SearchQuery::new(query, MatchMode::Fuzzy)
}

/// What is left of `query` once `label` consumes the words it matches.
fn remaining(query: SearchQuery, label: &str) -> SearchQuery {
    query.without_words_matching(label)
}

#[test]
fn empty_query_matches_everything() {
    assert!(exact("").is_empty());
    assert!(exact("   ").is_empty());
    assert!(exact("").matches("rook agent global ai toggle"));
    assert!(fuzzy("").matches(""));
}

#[test]
fn exact_requires_every_word_in_any_order_and_case() {
    let terms = "active ai autosuggestions prompt";
    assert!(exact("autosuggestions").matches(terms));
    assert!(exact("ACTIVE AI").matches(terms));
    assert!(exact("prompt active").matches(terms));
    assert!(!exact("autosuggestions key").matches(terms));

    let terms = "rook agent global ai toggle";
    assert!(!exact("file search").matches(terms));
}

#[test]
fn exact_matches_substrings_including_punctuation() {
    assert!(exact("party").matches("third-party agent"));
    assert!(exact("a.i.").matches("ai a.i. prompt"));
    assert!(exact("suggest").matches("autosuggestions"));
}

#[test]
fn exact_finds_the_singular_of_a_plural_word() {
    assert!(exact("themes").matches("sync with os theme"));
    assert!(exact("aliases").matches("expand alias expansion"));
    // The stem only counts at the start of a word.
    assert!(!exact("tabs").matches("crash reports stability"));
    // Too short to strip: "bus" is not searched as "bu".
    assert!(!exact("bus").matches("build button"));
    assert!(exact("buses").matches("event bus"));
    assert!(exact("patches").matches("apply patch"));
}

#[test]
fn exact_strips_es_only_after_a_sibilant() {
    assert!(exact("files").matches("file search"));
    assert!(!exact("files").matches("filter output"));
    assert!(!exact("notes").matches("desktop notifications"));
    assert!(!exact("lines").matches("open links"));
}

#[test]
fn exact_rejects_typos() {
    assert!(!exact("opacty").matches("window opacity"));
    assert!(!exact("mdoe").matches("vim mode keybindings"));
}

#[test]
fn fuzzy_tolerates_typos() {
    let terms = "window opacity transparency";
    // A missing letter, swapped letters, and a typo in each word.
    assert!(fuzzy("opacty").matches(terms));
    assert!(fuzzy("opcaity").matches(terms));
    assert!(fuzzy("windwo opactiy").matches(terms));
    // A wrong letter.
    assert!(fuzzy("sursor shape").matches("cursor shape"));

    let terms = "text terminal font family font size";
    assert!(fuzzy("fnt sise").matches(terms));
}

#[test]
fn fuzzy_allows_two_typos_only_in_long_words() {
    assert!(fuzzy("notifcaitons").matches("notifications"));
    assert!(!fuzzy("fnott").matches("font size"));
}

#[test]
fn fuzzy_matches_a_partly_typed_word_with_a_typo() {
    assert!(fuzzy("apperan").matches("appearance"));
}

#[test]
fn fuzzy_does_not_correct_short_words() {
    assert!(!fuzzy("tap").matches("tab bar close button"));
}

#[test]
fn fuzzy_still_requires_every_word() {
    let terms = "text terminal font family font size";
    assert!(!fuzzy("font color").matches(terms));
}

#[test]
fn fuzzy_matches_abbreviations_anchored_at_the_word_start() {
    assert!(fuzzy("ntf").matches("desktop notifications"));
    // Must start where the word starts.
    assert!(!fuzzy("otf").matches("desktop notifications"));
    // Letters spread past twice the abbreviation's length do not count.
    assert!(!fuzzy("kbd").matches("keybindings keyboard"));
}

#[test]
fn a_label_consumes_the_words_it_matches() {
    let query = exact("appearance opacity");
    assert_eq!(remaining(query, "Appearance"), exact("opacity"));

    let query = exact("Features opacity");
    assert_eq!(remaining(query.clone(), "Appearance"), query);

    let query = exact("agents");
    assert!(remaining(query, "Rook Agent Agents").is_empty());

    let query = exact("opacity");
    assert_eq!(remaining(query.clone(), ""), query);
}

#[test]
fn a_label_consumes_only_words_that_start_one_of_its_words() {
    let query = exact("appear opacity");
    assert_eq!(remaining(query, "Appearance"), exact("opacity"));

    let query = exact("keyboard shortcuts");
    assert!(remaining(query, "Keyboard shortcuts").is_empty());

    for word in ["count", "age", "board", "cut"] {
        let query = exact(word);
        assert_eq!(
            remaining(
                query.clone(),
                "Account Billing and usage Keyboard shortcuts"
            ),
            query
        );
    }

    let query = exact("pro");
    assert!(remaining(query, "Profiles").is_empty());
}

#[test]
fn a_widget_still_matches_mid_word() {
    assert!(exact("count").matches("account"));
}

#[test]
fn a_label_consumes_misspelled_words_only_in_fuzzy_mode() {
    let query = exact("apearance opacity");
    assert_eq!(remaining(query.clone(), "Appearance"), query);

    let query = fuzzy("apearance opacity");
    assert_eq!(remaining(query, "Appearance"), fuzzy("opacity"));
}

#[test]
fn fuzzy_keeps_the_words() {
    assert_eq!(exact("Vim Mdoe").fuzzy(), fuzzy("vim mdoe"));
}
