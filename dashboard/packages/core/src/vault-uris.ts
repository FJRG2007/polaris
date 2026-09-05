/**
 * Which addresses a saved login belongs to.
 *
 * One login is rarely one URL. The account is used at `example.com`, at
 * `accounts.example.com`, at `login.example.co.uk`, and in an app whose callback
 * is something else entirely - so a vault that holds one website per item is a
 * vault whose autofill misses most of the time and whose owner ends up keeping
 * the same credential three times.
 *
 * The vocabulary is Bitwarden's, because the vault speaks its protocol and a
 * client reading these ciphers has to understand what it finds. `match` is the
 * number that client already knows; nothing here is a Polaris invention.
 *
 * The wildcard people expect is the exception worth explaining. Everybody writes
 * `*.example.com` and means "that site and anything under it", so that is
 * accepted as it is typed - and stored as the base-domain match, which is
 * precisely what it means and is what every other client already implements. The
 * alternative would be storing a pattern only Polaris understands, in a vault
 * whose whole point is that other clients can read it.
 */

import {
    URI_MATCH_DOMAIN,
    URI_MATCH_EXACT,
    URI_MATCH_HOST,
    URI_MATCH_NEVER,
    URI_MATCH_REGEX,
    URI_MATCH_STARTS_WITH
} from "./vault.js";

export type UriMatch =
    | typeof URI_MATCH_DOMAIN
    | typeof URI_MATCH_HOST
    | typeof URI_MATCH_STARTS_WITH
    | typeof URI_MATCH_EXACT
    | typeof URI_MATCH_REGEX
    | typeof URI_MATCH_NEVER;

/** What each match means, in the words the editor shows. Written as sentences
 *  rather than as jargon: "host" and "domain" are the same word to most people,
 *  and the difference between them is exactly what has to be understood. */
export const URI_MATCH_LABELS: Record<UriMatch, string> = {
    [URI_MATCH_DOMAIN]: "The site and anything under it",
    [URI_MATCH_HOST]: "This exact host",
    [URI_MATCH_STARTS_WITH]: "Any address starting with this",
    [URI_MATCH_EXACT]: "This address exactly",
    [URI_MATCH_REGEX]: "A pattern I have written",
    [URI_MATCH_NEVER]: "Never offer this login here"
};

/** Every match, in the order the picker lists them: commonest first. */
export const URI_MATCHES: readonly UriMatch[] = [
    URI_MATCH_DOMAIN,
    URI_MATCH_HOST,
    URI_MATCH_STARTS_WITH,
    URI_MATCH_EXACT,
    URI_MATCH_REGEX,
    URI_MATCH_NEVER
];

/** A match number as stored, or null - which Bitwarden reads as "whatever the
 *  vault's default is", and here means the base-domain match. */
export function readUriMatch(value: unknown): UriMatch | null {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return (URI_MATCHES as readonly number[]).includes(number) ? (number as UriMatch) : null;
}

/** What a null match means when something has to actually decide. */
export const DEFAULT_URI_MATCH: UriMatch = URI_MATCH_DOMAIN;

/**
 * The host part of whatever somebody typed.
 *
 * People type `example.com`, `https://example.com/login?next=x` and
 * `*.example.com` into the same box, and all three name the same site. Null for
 * something with no host in it at all, which is not an address however it is
 * matched.
 */
export function hostOf(value: string): string | null {
    const text = value.trim().toLowerCase();
    if (!text) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
    try {
        const host = new URL(withScheme).hostname;
        return host || null;
    } catch {
        return null;
    }
}

/**
 * The base domain: the registrable name plus its suffix.
 *
 * A deliberate approximation, and the comment matters more than the code. Doing
 * this exactly needs the public suffix list - three thousand rules, updated
 * monthly - to know that `co.uk` is a suffix and `com.br` is too while
 * `github.io` is as well. Shipping and refreshing that list is a real cost for a
 * gain that only shows on the last label: without it, `a.example.co.uk` and
 * `b.example.co.uk` are still recognised as the same site, and the case that
 * suffers is two unrelated sites sharing a two-label suffix.
 *
 * So: the last two labels, or three when the second-to-last is one of the
 * handful of second-level suffixes people here actually use. Under-matching
 * means autofill is not offered; over-matching would mean offering a credential
 * on somebody else's site, so the list stays short and the failure stays on the
 * safe side.
 */
const SECOND_LEVEL = new Set([
    "co",
    "com",
    "net",
    "org",
    "gov",
    "edu",
    "ac",
    "mil"
]);

export function baseDomain(host: string): string {
    const labels = host.toLowerCase().split(".").filter(Boolean);
    if (labels.length <= 2) return labels.join(".");
    const [secondLast] = labels.slice(-2, -1);
    const take = secondLast && SECOND_LEVEL.has(secondLast) ? 3 : 2;
    return labels.slice(-take).join(".");
}

/**
 * What to store for what somebody typed.
 *
 * The one transformation here is the wildcard: `*.example.com` is how everybody
 * writes "this site and its subdomains", and it becomes `example.com` with the
 * base-domain match - the same meaning, in the form every client understands.
 * Everything else is stored as it was typed, because a URL somebody pasted is a
 * URL they may want to see again.
 */
export function readUriEntry(typed: string, match: UriMatch | null): { uri: string; match: UriMatch | null } {
    const value = typed.trim();
    const wildcard = /^\*\.(.+)$/.exec(value);
    if (wildcard?.[1]) return { uri: wildcard[1], match: URI_MATCH_DOMAIN };
    return { uri: value, match };
}

/**
 * What is wrong with what somebody has typed into a website box, or null.
 *
 * Deliberately permissive about what an address is. A vault holds `localhost:8080`,
 * the router at `192.168.1.1` and a machine called `nas` as readily as it holds
 * `example.com`, and a form that refused those would be a form arguing with
 * somebody about their own network. What it refuses is what cannot be an address
 * at all - text with spaces in it, a scheme with nothing after it.
 *
 * An empty box is not wrong, it is unfinished: nothing is said about it until
 * there is something to say something about.
 *
 * The pattern is the exception, and it is why this takes the match. Under "a
 * pattern I have written" the value is a regular expression rather than a URL,
 * so reading it as an address would refuse every correct pattern and accept
 * every broken one - and a pattern that will not compile matches nothing, which
 * is a saved login that is silently never offered.
 */
export function uriProblem(typed: string, match: UriMatch | null): string | null {
    const value = typed.trim();
    if (!value) return null;

    if ((match ?? DEFAULT_URI_MATCH) === URI_MATCH_REGEX) {
        try {
            new RegExp(value, "iu");
            return null;
        } catch {
            return "That pattern will not compile, so it would never match anything.";
        }
    }

    // The wildcard is checked as the address it stands for.
    const address = /^\*\.(.+)$/.exec(value)?.[1] ?? value;
    return hostOf(address) ? null : "That does not look like a web address.";
}

/**
 * Whether a saved address covers the page somebody is on.
 *
 * The one function autofill would ask, written here so the rule can be read and
 * tested without a browser. A saved entry that is not an address at all matches
 * nothing rather than everything - the failure that would offer every credential
 * on every page.
 */
export function uriMatches(saved: string, match: UriMatch | null, candidate: string): boolean {
    const rule = match ?? DEFAULT_URI_MATCH;
    if (rule === URI_MATCH_NEVER) return false;

    const savedValue = saved.trim();
    const candidateValue = candidate.trim();
    if (!savedValue || !candidateValue) return false;

    if (rule === URI_MATCH_EXACT) return savedValue === candidateValue;
    if (rule === URI_MATCH_STARTS_WITH) return candidateValue.startsWith(savedValue);
    if (rule === URI_MATCH_REGEX) {
        try {
            // Anchored by the author if they want it anchored: this is their own
            // pattern, and a `u` flag keeps it from being read as anything else.
            return new RegExp(savedValue, "iu").test(candidateValue);
        } catch {
            // A pattern that will not compile matches nothing. Matching
            // everything would offer this credential on every page there is.
            return false;
        }
    }

    const savedHost = hostOf(savedValue);
    const candidateHost = hostOf(candidateValue);
    if (!savedHost || !candidateHost) return false;
    if (rule === URI_MATCH_HOST) return savedHost === candidateHost;
    const base = baseDomain(savedHost);
    return base.length > 0 && (candidateHost === base || candidateHost.endsWith(`.${base}`));
}

/** The saved addresses that cover a page, best first: the most specific rule
 *  wins, so an exact address is offered before a whole-domain one. */
export function urisCovering<T extends { uri: string; match: UriMatch | null }>(
    entries: readonly T[],
    candidate: string
): T[] {
    return entries
        .filter((entry) => uriMatches(entry.uri, entry.match, candidate))
        .sort((left, right) => (right.match ?? DEFAULT_URI_MATCH) - (left.match ?? DEFAULT_URI_MATCH));
}
