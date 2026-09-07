/**
 * What somebody typed into the mail search box.
 *
 * Two jobs, and they are the same grammar read in both directions: turn a line
 * of text into the things to narrow by, and turn those things back into a line
 * of text. That is what lets the box and the filter panel be one feature - the
 * panel writes the box, the box fills the panel, and a search stays a page
 * somebody can bookmark rather than a form they have to fill in again.
 *
 * The operators are Gmail's, deliberately. Nobody wants to learn a second
 * dialect for the same idea, and half the people who type `from:` here will be
 * typing it out of habit.
 *
 * Everything unrecognised falls through to the free text, which is the rule that
 * keeps this from being a parser somebody has to fight: a colon in the middle of
 * a sentence is a sentence, not a syntax error.
 */

/** What a search narrows by. */
export interface MailSearchTerms {
    /** The words with no operator on them, matched loosely. */
    readonly text: string;
    /** `"in quotes"` - these have to appear exactly. */
    readonly phrases: readonly string[];
    /** `-word` and `-"a phrase"` - these must not appear. */
    readonly without: readonly string[];
    readonly from: readonly string[];
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly subject: readonly string[];
    readonly hasAttachment: boolean;
    /** `has:link` - a message carrying an address somebody can follow. */
    readonly hasLink: boolean;
    /** `is:unread` / `is:read`, or null for neither. */
    readonly unread: boolean | null;
    readonly starred: boolean | null;
    /** `after:` and `before:`, as `yyyy-mm-dd`, or "" for neither. */
    readonly after: string;
    readonly before: string;
}

export const EMPTY_SEARCH: MailSearchTerms = {
    text: "",
    phrases: [],
    without: [],
    from: [],
    to: [],
    cc: [],
    subject: [],
    hasAttachment: false,
    hasLink: false,
    unread: null,
    starred: null,
    after: "",
    before: ""
};

/** Everything that means the same thing, so a habit from another client works
 *  here. `newer`/`older` are Gmail's, `since`/`until` are everybody else's. */
const AFTER_KEYS = ["after", "since", "newer", "newer_than"];
const BEFORE_KEYS = ["before", "until", "older", "older_than"];

/**
 * One line of search, taken apart.
 *
 * A small scanner rather than a regular expression because of the quotes:
 * `subject:"the quarterly report"` is one term, and no expression that also has
 * to cope with a bare word stays readable.
 */
export function parseMailSearch(input: string, now: Date = new Date()): MailSearchTerms {
    const phrases: string[] = [];
    const without: string[] = [];
    const from: string[] = [];
    const to: string[] = [];
    const cc: string[] = [];
    const subject: string[] = [];
    const words: string[] = [];
    let hasAttachment = false;
    let hasLink = false;
    let unread: boolean | null = null;
    let starred: boolean | null = null;
    let after = "";
    let before = "";

    for (const token of tokenize(input)) {
        const negated = token.startsWith("-") && token.length > 1;
        const body = negated ? token.slice(1) : token;
        const colon = body.indexOf(":");
        const key = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
        const value = colon > 0 ? unquote(body.slice(colon + 1)) : "";

        if (!key || !value) {
            const bare = unquote(body);
            if (!bare) continue;
            if (negated) without.push(bare);
            else if (isQuoted(body)) phrases.push(bare);
            else words.push(bare);
            continue;
        }

        if (key === "from") {
            from.push(value.toLowerCase());
            continue;
        }
        if (key === "to") {
            to.push(value.toLowerCase());
            continue;
        }
        if (key === "cc") {
            cc.push(value.toLowerCase());
            continue;
        }
        if (key === "subject") {
            subject.push(value);
            continue;
        }
        if (key === "has") {
            if (value.toLowerCase() === "attachment") hasAttachment = !negated;
            else if (value.toLowerCase() === "link") hasLink = !negated;
            continue;
        }
        if (key === "is") {
            const what = value.toLowerCase();
            if (what === "unread") unread = !negated;
            else if (what === "read") unread = negated;
            else if (what === "starred") starred = !negated;
            continue;
        }
        if (AFTER_KEYS.includes(key)) {
            const found = readDate(value, now);
            if (found) after = found;
            continue;
        }
        if (BEFORE_KEYS.includes(key)) {
            const found = readDate(value, now);
            if (found) before = found;
            continue;
        }

        // Not an operator anybody declared. It is a sentence with a colon in it.
        const bare = unquote(body);
        if (negated) without.push(bare);
        else words.push(bare);
    }

    return {
        text: words.join(" ").trim(),
        phrases,
        without,
        from,
        to,
        cc,
        subject,
        hasAttachment,
        hasLink,
        unread,
        starred,
        after,
        before
    };
}

/** Whether anything at all was asked for. An empty search is a plain list. */
export function searchIsEmpty(terms: MailSearchTerms): boolean {
    return (
        !terms.text &&
        terms.phrases.length === 0 &&
        terms.without.length === 0 &&
        terms.from.length === 0 &&
        terms.to.length === 0 &&
        terms.cc.length === 0 &&
        terms.subject.length === 0 &&
        !terms.hasAttachment &&
        !terms.hasLink &&
        terms.unread === null &&
        terms.starred === null &&
        !terms.after &&
        !terms.before
    );
}

/**
 * The same search, written back out.
 *
 * The panel edits the terms and this is what it puts in the box, so the two are
 * never telling different stories - and what comes out has to parse back to what
 * went in, which is the property the tests hold this to.
 */
export function formatMailSearch(terms: MailSearchTerms): string {
    const parts: string[] = [];
    for (const value of terms.from) parts.push(`from:${quote(value)}`);
    for (const value of terms.to) parts.push(`to:${quote(value)}`);
    for (const value of terms.cc) parts.push(`cc:${quote(value)}`);
    for (const value of terms.subject) parts.push(`subject:${quote(value)}`);
    if (terms.hasAttachment) parts.push("has:attachment");
    if (terms.hasLink) parts.push("has:link");
    if (terms.unread === true) parts.push("is:unread");
    if (terms.unread === false) parts.push("is:read");
    if (terms.starred === true) parts.push("is:starred");
    if (terms.after) parts.push(`after:${terms.after}`);
    if (terms.before) parts.push(`before:${terms.before}`);
    for (const phrase of terms.phrases) parts.push(`"${phrase}"`);
    for (const value of terms.without) parts.push(`-${quote(value)}`);
    if (terms.text) parts.push(terms.text);
    return parts.join(" ");
}

/** Split on spaces, except inside quotes. A quote that is never closed runs to
 *  the end, which is what somebody halfway through typing one has. */
function tokenize(input: string): string[] {
    const out: string[] = [];
    let held = "";
    let quoted = false;
    for (const char of input) {
        if (char === QUOTE) {
            quoted = !quoted;
            held += char;
            continue;
        }
        if (!quoted && /\s/.test(char)) {
            if (held) out.push(held);
            held = "";
            continue;
        }
        held += char;
    }
    if (held) out.push(held);
    return out;
}

const QUOTE = String.fromCharCode(34);

function isQuoted(value: string): boolean {
    return value.length > 1 && value.startsWith(QUOTE);
}

function unquote(value: string): string {
    return value.split(QUOTE).join("").trim();
}

/** Quoted only when it has to be, so the box reads like something a person
 *  wrote rather than like a query language. */
function quote(value: string): string {
    return /\s/.test(value) ? `${QUOTE}${value}${QUOTE}` : value;
}

/**
 * A day, from what somebody typed.
 *
 * Both the written form and the one Gmail uses for "the last week": `7d`, `2w`,
 * `3m`, `1y`. The relative one is resolved to a date here rather than carried,
 * because a search that means something different tomorrow is one nobody can
 * bookmark.
 */
function readDate(value: string, now: Date): string {
    const relative = /^(\d+)\s*([dwmy])$/i.exec(value.trim());
    if (relative) {
        const count = Number(relative[1]);
        const unit = (relative[2] ?? "d").toLowerCase();
        const when = new Date(now);
        if (unit === "d") when.setDate(when.getDate() - count);
        if (unit === "w") when.setDate(when.getDate() - count * 7);
        if (unit === "m") when.setMonth(when.getMonth() - count);
        if (unit === "y") when.setFullYear(when.getFullYear() - count);
        return day(when);
    }
    const written = value.trim().replace(/\//g, "-");
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(written)) return "";
    const parsed = new Date(`${written}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? "" : day(parsed);
}

function day(when: Date): string {
    const month = String(when.getMonth() + 1).padStart(2, "0");
    const date = String(when.getDate()).padStart(2, "0");
    return `${when.getFullYear()}-${month}-${date}`;
}

/**
 * What a message has to look like for a search to be able to match it.
 *
 * The shape both sides agree on: the server builds one of these per message and
 * the matcher reads nothing else. Keeping it this narrow is what lets the
 * matching be a pure function that can be tested without a mailbox.
 */
export interface MailSearchable {
    readonly subject: string;
    readonly snippet: string;
    readonly body: string;
    readonly from: readonly string[];
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly hasAttachments: boolean;
    readonly seen: boolean;
    readonly flagged: boolean;
    readonly sentAt: Date;
}

/** Whether a message satisfies everything that has to be exactly true. What is
 *  left after this - the loose words - is ranked rather than tested. */
export function mailSearchAdmits(message: MailSearchable, terms: MailSearchTerms): boolean {
    const everything = `${message.subject}\n${message.snippet}\n${message.body}`.toLowerCase();
    const people = [...message.from, ...message.to, ...message.cc].join(" ").toLowerCase();

    for (const phrase of terms.phrases) {
        if (!everything.includes(phrase.toLowerCase())) return false;
    }
    for (const word of terms.without) {
        const missing = word.toLowerCase();
        if (everything.includes(missing) || people.includes(missing)) return false;
    }
    for (const word of terms.subject) {
        if (!message.subject.toLowerCase().includes(word.toLowerCase())) return false;
    }
    if (!matchesEvery(message.from, terms.from)) return false;
    if (!matchesEvery(message.to, terms.to)) return false;
    if (!matchesEvery(message.cc, terms.cc)) return false;
    if (terms.hasAttachment && !message.hasAttachments) return false;
    if (terms.hasLink && !/https?:\/\/\S+/i.test(`${message.snippet} ${message.body}`)) return false;
    if (terms.unread !== null && message.seen === terms.unread) return false;
    if (terms.starred !== null && message.flagged !== terms.starred) return false;
    if (terms.after && message.sentAt < new Date(`${terms.after}T00:00:00`)) return false;
    // `before:` is the whole of that day, which is what anybody means by it.
    if (terms.before && message.sentAt > new Date(`${terms.before}T23:59:59.999`)) return false;
    return true;
}

/** Whether the addresses on the message answer to every name asked for. Matched
 *  as a substring, so `from:ana` finds `ana@example.com` and `Ana Ruiz` alike -
 *  which is how people search their mail. */
function matchesEvery(addresses: readonly string[], wanted: readonly string[]): boolean {
    if (wanted.length === 0) return true;
    const haystack = addresses.join(" ").toLowerCase();
    return wanted.every((one) => haystack.includes(one));
}
