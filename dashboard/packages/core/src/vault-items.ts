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

/** The field a card's issuing bank lives in. The cipher model has the network -
 *  Visa, Mastercard - and nothing for who issued it, and two cards from one
 *  network look identical in a list without it. */
export const BANK_FIELD = "Bank";

/** The field a chosen icon lives in. One or two characters - an emoji - so it
 *  costs nothing to store, nothing to fetch, and cannot be a picture of
 *  something else. */
export const ICON_FIELD = "Icon";

/**
 * How short a master password may be.
 *
 * The number that has always been enforced, and the reason it is a named
 * constant rather than a literal in a form: the unlock screen refuses anything
 * shorter before asking the server, and that is only safe while it is the same
 * number the setup screen has always used. Raise it and every vault created
 * under the old one still has to open.
 */
export const MASTER_PASSWORD_MIN = 12;

/**
 * What is wrong with a master password somebody is CHOOSING, or null.
 *
 * Length first and hardest, because it is the only one that reliably buys
 * anything against an offline attack on a stolen database. The character classes
 * are the weaker rule and are asked for as a pair rather than as four boxes to
 * tick: "a capital, a number and a symbol" is how people end up with
 * `Password1!`, which is four classes and one guess.
 */
export function masterPasswordProblem(password: string): string | null {
    if (password.length === 0) return null;
    if (password.length < MASTER_PASSWORD_MIN) {
        return `Use at least ${MASTER_PASSWORD_MIN} characters.`;
    }
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((shape) => shape.test(password)).length;
    if (classes < 2) {
        return "Mix at least two kinds of character - letters and numbers, or letters and punctuation.";
    }
    return null;
}

/**
 * Whether this could even be the master password of an existing vault.
 *
 * Deliberately weaker than the rule above, and the difference is the whole
 * point. A vault made before a rule existed still has to open, so the unlock
 * screen may only refuse what could never have been accepted at any point -
 * which is the length, and nothing else. Refusing on the character classes here
 * would lock somebody out of their own vault to enforce a rule invented after
 * they filled it.
 *
 * What it saves is real: a wrong guess costs a key derivation on this machine
 * and a request the server has to rate-limit, and neither is worth spending on
 * something that cannot be the answer.
 */
export function couldBeMasterPassword(password: string): boolean {
    return password.length >= MASTER_PASSWORD_MIN;
}

/** One custom field, by name. Empty when the item has none - which is the
 *  ordinary case, since these are conventions rather than columns. */
export function fieldValue(
    fields: readonly { name: string; value: string }[],
    name: string
): string {
    return fields.find((field) => field.name === name)?.value ?? "";
}

/**
 * The fields with one of them set, added or removed.
 *
 * Removed when the value is emptied, rather than kept as an empty field: a
 * vault item that accumulates blank fields nobody can see the purpose of is a
 * vault item somebody has to tidy by hand.
 */
export function withField<T extends { name: string; value: string; type: number }>(
    fields: readonly T[],
    name: string,
    value: string,
    type: number
): T[] {
    const rest = fields.filter((field) => field.name !== name);
    if (!value.trim()) return rest;
    const existing = fields.find((field) => field.name === name);
    return [...rest, { ...(existing ?? ({} as T)), name, value, type }];
}

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
