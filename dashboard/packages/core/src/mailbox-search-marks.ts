/**
 * Showing a search's answer: which words to mark, where they are in a piece of
 * text, the line of a message worth showing for them, and the search taken
 * apart into the chips above the results.
 *
 * Everything here works on plain text and returns plain data. Nothing builds
 * markup out of a string, so a subject or a body that holds `<script>` is drawn
 * as the characters it is: the caller renders the segments as text nodes.
 */

import { normalizeSearchText } from "./search-text.js";
import { EMPTY_SEARCH, type MailSearchTerms } from "./mailbox-search.js";

/**
 * The words a search asks for, as they are looked for in text: the loose words
 * one by one, each quoted phrase whole, and what `subject:` named. Who a message
 * is from is not here - that is a column, not a word in the body.
 */
export function mailSearchNeedles(terms: MailSearchTerms): string[] {
    const out = new Set<string>();
    const add = (value: string) => {
        const folded = normalizeSearchText(value);
        if (folded.length > 0) out.add(folded);
    };
    for (const word of terms.text.split(/\s+/)) add(word);
    for (const phrase of terms.phrases) add(phrase);
    for (const value of terms.subject) add(value);
    // Longest first, so "report" inside "quarterly report" does not split a
    // phrase that was asked for whole.
    return [...out].sort((a, b) => b.length - a.length);
}

/** One run of text, marked when it is something the search asked for. */
export interface MarkedSegment {
    readonly text: string;
    readonly hit: boolean;
}

/**
 * The text folded the way a search compares it, one character at a time, with
 * where each folded character came from - so a match found in "accion" can be
 * marked on "Acción" as written.
 */
function foldWithOrigins(text: string): { folded: string; origin: number[] } {
    let folded = "";
    const origin: number[] = [];
    let index = 0;
    for (const char of text) {
        const plain = char
            .normalize("NFD")
            .replace(/\p{M}+/gu, "")
            .toLowerCase()
            .replace(/[\s_]/g, " ");
        for (const piece of plain) {
            folded += piece;
            origin.push(index);
        }
        index += char.length;
    }
    origin.push(text.length);
    return { folded, origin };
}

/** Where the needles are in the text, as `[start, end)` ranges of the text as
 *  written, sorted and never overlapping. */
export function mailSearchHits(text: string, needles: readonly string[]): [number, number][] {
    if (!text || needles.length === 0) return [];
    const { folded, origin } = foldWithOrigins(text);
    const ranges: [number, number][] = [];
    for (const needle of needles) {
        if (!needle) continue;
        let from = 0;
        for (;;) {
            const at = folded.indexOf(needle, from);
            if (at < 0) break;
            ranges.push([origin[at]!, origin[at + needle.length]!]);
            from = at + needle.length;
        }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }
    return merged;
}

/** The text cut into runs, the matched ones marked. Rendered as text, never as
 *  markup. */
export function markMailSearch(text: string, needles: readonly string[]): MarkedSegment[] {
    const hits = mailSearchHits(text, needles);
    if (hits.length === 0) return text ? [{ text, hit: false }] : [];
    const out: MarkedSegment[] = [];
    let at = 0;
    for (const [start, end] of hits) {
        if (start > at) out.push({ text: text.slice(at, start), hit: false });
        out.push({ text: text.slice(start, end), hit: true });
        at = end;
    }
    if (at < text.length) out.push({ text: text.slice(at), hit: false });
    return out;
}

/**
 * The line of a message to show under a search result: the part around the
 * first word that matched, cut at word edges, with an ellipsis on whichever end
 * was cut. Falls back to the start of the text when nothing in it matched.
 */
export function mailSearchExcerpt(text: string, needles: readonly string[], length = 160): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= length) return flat;
    const first = mailSearchHits(flat, needles)[0];
    if (!first) return `${flat.slice(0, length).replace(/\s+\S*$/, "")}...`;
    // A little context before the word, most of the room after it.
    let start = Math.max(0, first[0] - Math.floor(length / 4));
    if (start > 0) {
        const space = flat.indexOf(" ", start);
        start = space >= 0 && space < first[0] ? space + 1 : start;
    }
    let end = Math.min(flat.length, start + length);
    if (end < flat.length) {
        const space = flat.lastIndexOf(" ", end);
        end = space > first[1] ? space : end;
    }
    return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`;
}

/** One condition of a search, drawn as a chip that can be taken off. */
export interface MailSearchChip {
    /** Stable within one search: which field and which of its values. */
    readonly id: string;
    /** The operator as typed, without the colon - `from`, `has`, `"` for a phrase. */
    readonly operator: string;
    readonly value: string;
    readonly negated: boolean;
}

type ListKey = "from" | "to" | "cc" | "subject" | "phrases" | "without" | "filename" | "label";
const LIST_KEYS: readonly ListKey[] = [
    "from",
    "to",
    "cc",
    "subject",
    "filename",
    "label",
    "phrases",
    "without"
];

/** Every condition of a search except the loose words, which stay in the box. */
export function mailSearchChips(terms: MailSearchTerms): MailSearchChip[] {
    const chips: MailSearchChip[] = [];
    for (const key of LIST_KEYS) {
        terms[key].forEach((value, index) =>
            chips.push({
                id: `${key}:${index}`,
                operator: key === "phrases" ? '"' : key === "without" ? "-" : key,
                value,
                negated: key === "without"
            })
        );
    }
    if (terms.hasAttachment)
        chips.push({ id: "has:attachment", operator: "has", value: "attachment", negated: false });
    if (terms.hasLink) chips.push({ id: "has:link", operator: "has", value: "link", negated: false });
    if (terms.unread !== null)
        chips.push({
            id: "is:unread",
            operator: "is",
            value: terms.unread ? "unread" : "read",
            negated: false
        });
    if (terms.starred !== null)
        chips.push({ id: "is:starred", operator: "is", value: "starred", negated: !terms.starred });
    if (terms.after) chips.push({ id: "after", operator: "after", value: terms.after, negated: false });
    if (terms.before)
        chips.push({ id: "before", operator: "before", value: terms.before, negated: false });
    return chips;
}

/** The same search with one chip taken off. */
export function withoutMailSearchChip(terms: MailSearchTerms, id: string): MailSearchTerms {
    const [key, index] = id.split(":");
    if (LIST_KEYS.includes(key as ListKey) && index !== undefined) {
        const list = terms[key as ListKey].filter((_, at) => String(at) !== index);
        return { ...terms, [key as ListKey]: list };
    }
    if (id === "has:attachment") return { ...terms, hasAttachment: false };
    if (id === "has:link") return { ...terms, hasLink: false };
    if (id === "is:unread") return { ...terms, unread: EMPTY_SEARCH.unread };
    if (id === "is:starred") return { ...terms, starred: EMPTY_SEARCH.starred };
    if (id === "after") return { ...terms, after: "" };
    if (id === "before") return { ...terms, before: "" };
    return terms;
}

/** The operators the box offers as somebody types, in the order offered. The
 *  label for each is the caller's to translate, keyed by `key`. */
export const MAIL_SEARCH_OPERATORS = [
    { key: "from", insert: "from:" },
    { key: "to", insert: "to:" },
    { key: "cc", insert: "cc:" },
    { key: "subject", insert: "subject:" },
    { key: "hasAttachment", insert: "has:attachment" },
    { key: "hasLink", insert: "has:link" },
    { key: "filename", insert: "filename:" },
    { key: "label", insert: "label:" },
    { key: "unread", insert: "is:unread" },
    { key: "read", insert: "is:read" },
    { key: "starred", insert: "is:starred" },
    { key: "after", insert: "after:" },
    { key: "before", insert: "before:" },
    { key: "newer", insert: "newer_than:7d" }
] as const;

export type MailSearchOperatorKey = (typeof MAIL_SEARCH_OPERATORS)[number]["key"];

/**
 * The operators worth offering for the word being typed: the last word of the
 * line, when it is the start of one. Nothing for a word that already has its
 * colon, or for an empty one - a list under an empty box is in the way.
 */
export function mailSearchOperatorHints(
    line: string
): (typeof MAIL_SEARCH_OPERATORS)[number][] {
    const last = /(?:^|\s)-?([a-z_:]*)$/i.exec(line)?.[1]?.toLowerCase() ?? "";
    if (!last) return [];
    return MAIL_SEARCH_OPERATORS.filter(
        (operator) => operator.insert.startsWith(last) && operator.insert !== last
    );
}

/** The line with its last word replaced by an operator. */
export function applyMailSearchOperator(line: string, insert: string): string {
    const replaced = line.replace(/(^|\s)(-?)[a-z_:]*$/i, `$1$2${insert}`);
    return insert.endsWith(":") ? replaced : `${replaced} `;
}

/** How many recent searches are kept. */
export const RECENT_MAIL_SEARCHES = 8;

/** The recent list with one more search put first. Empty searches are not
 *  kept, and the same search twice is one entry. */
export function rememberMailSearch(recent: readonly string[], query: string): string[] {
    const line = query.trim().replace(/\s+/g, " ");
    if (!line) return [...recent];
    return [line, ...recent.filter((held) => held !== line)].slice(0, RECENT_MAIL_SEARCHES);
}
