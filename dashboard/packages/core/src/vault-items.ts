/**
 * The conventions a vault item carries beyond what Bitwarden gave names to.
 *
 * Recovery codes, a chosen icon: neither exists in the cipher model, and both
 * are things people keep in a password manager anyway. The choice is between
 * inventing columns that only Polaris understands - in a vault whose entire
 * point is that other clients can read it - and putting them in the one place
 * the model already leaves open, which is a custom field.
 *
 * So they are custom fields with agreed names. A Bitwarden client shows them as
 * fields, which is exactly what they are; Polaris recognises the names and draws
 * them properly. Nothing is lost either way round, and an item exported from
 * here and opened somewhere else is still whole.
 *
 * Hidden rather than plain for the codes, because a recovery code is a password:
 * it should be behind the same press as one.
 */

/** The field a login's recovery codes live in. */
export const RECOVERY_CODES_FIELD = "Recovery codes";

/** The field a chosen icon lives in. One or two characters - an emoji - so it
 *  costs nothing to store, nothing to fetch, and cannot be a picture of
 *  something else. */
export const ICON_FIELD = "Icon";

/**
 * The codes in whatever was pasted in.
 *
 * Sites hand these out in every shape there is: one per line, separated by
 * spaces, in a numbered list, with dashes inside them. What they have in common
 * is that the code itself never contains whitespace, so the split is on
 * whitespace and the numbering is what has to be taken back off.
 *
 * Order is kept. People work down the list they were given, and a set that came
 * back in a different order every time would make "which have I used" impossible
 * to hold in your head.
 */
export function readRecoveryCodes(value: string): string[] {
    return value
        .split(/\s+/)
        .map((token) => token.trim())
        // A leading "3." or "3)" is the list's numbering rather than part of the
        // code - but only when what is left still looks like one.
        .map((token) => {
            const numbered = /^\d{1,2}[.)]$/.test(token) ? "" : token.replace(/^\d{1,2}[.)]/, "");
            return numbered;
        })
        .filter((token) => token.length > 0);
}

/** How the codes are written back: one per line, which is how every site that
 *  hands them out prints them and how anybody reading them expects to. */
export function writeRecoveryCodes(codes: readonly string[]): string {
    return codes.join("\n");
}

/**
 * Whether what is in the username box is an address.
 *
 * It nearly always is, which is the point: a field labelled "Username" holding
 * `ada@example.com` invites somebody to wonder whether the site wanted something
 * else. Knowing which it is lets the screen say so instead.
 *
 * Deliberately not a validating regex. This decides a label, so the cost of
 * being wrong is a word, and a permissive shape beats a correct one that
 * disagrees with the address somebody is actually signing in with.
 */
export function looksLikeEmail(value: string): boolean {
    const text = value.trim();
    return text.length > 2 && !/\s/.test(text) && /^[^@]+@[^@.]+\.[^@]+$/.test(text);
}

/**
 * The letters drawn on an item with no icon of its own.
 *
 * From the site rather than from the name where there is one: two items called
 * "Work" and "Work (old)" are the same two letters, while `github.com` and
 * `gitlab.com` are not. Falls back to the name, and then to a question mark,
 * because every item gets something.
 */
export function itemInitials(name: string, host: string | null): string {
    const source = host ? host.replace(/^www\./, "") : name;
    const word = source.trim().split(/[\s.\-_]+/).filter(Boolean)[0] ?? "";
    if (!word) return "?";
    return word.slice(0, 2).toUpperCase();
}
