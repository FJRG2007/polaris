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
 * The field a login's email lives in, apart from its username.
 *
 * Bitwarden's login has `username` and nothing else for who you are, and a site
 * that signs you in by handle still mails you at an address. So the username
 * stays exactly the username and the address is a plain custom field named
 * "Email" - which a Bitwarden client shows as a field, and its autofill matches
 * by name against a box called "email". A login that already carried a field of
 * that name is read as having that email, which is what it was.
 */
export const EMAIL_FIELD = "Email";

/**
 * An API key, which Bitwarden has no cipher type for.
 *
 * Stored as a Secure Note (`CIPHER_SECURE_NOTE`, type 2) carrying these custom
 * fields:
 *
 *   - `Polaris item` = `api-key` (text): the marker. Only a note with exactly
 *     this pair is an API key here; without it the same fields are an ordinary
 *     note's custom fields.
 *   - `API key` (text): the key, or the key id.
 *   - `Secret` (hidden): the secret, behind the same press as a password.
 *   - `Endpoint` (text, optional): the base URL it is used against.
 *
 * Named in words rather than codes because they are what a Bitwarden client, an
 * export or a CSV shows: a secure note with "API key", "Secret" and "Endpoint"
 * is usable anywhere, and the marker says where it came from.
 */
export const ITEM_KIND_FIELD = "Polaris item";
export const API_KEY_KIND = "api-key";
export const API_KEY_FIELD = "API key";
export const API_SECRET_FIELD = "Secret";
export const API_ENDPOINT_FIELD = "Endpoint";

/** The kind Polaris's own screens show an API key as, beside the cipher types.
 *  A screen's number only: what is stored is always `CIPHER_SECURE_NOTE`. */
export const ITEM_API_KEY = 100;

/** The fields an API key note is made of, marker included. */
export const API_KEY_FIELDS: readonly string[] = [
    ITEM_KIND_FIELD,
    API_KEY_FIELD,
    API_SECRET_FIELD,
    API_ENDPOINT_FIELD
];

/** Whether a stored item is one of Polaris's API keys: a secure note with the
 *  marker field. */
export function isApiKeyItem(item: {
    type: number;
    fields: readonly { name: string; value: string }[];
}): boolean {
    return item.type === 2 && fieldValue(item.fields, ITEM_KIND_FIELD) === API_KEY_KIND;
}

/** An API key's parts, read off its fields. */
export interface ApiKeyParts {
    key: string;
    secret: string;
    endpoint: string;
}

export function readApiKey(fields: readonly { name: string; value: string }[]): ApiKeyParts {
    return {
        key: fieldValue(fields, API_KEY_FIELD),
        secret: fieldValue(fields, API_SECRET_FIELD),
        endpoint: fieldValue(fields, API_ENDPOINT_FIELD)
    };
}

/** The fields with an API key's parts and its marker written in. Only the
 *  parts that changed are rewritten, so a field another client retyped keeps
 *  the kind it was given there. */
export function writeApiKey<T extends { name: string; value: string; type: number }>(
    fields: readonly T[],
    parts: ApiKeyParts
): T[] {
    const FIELD_TEXT = 0;
    const FIELD_HIDDEN = 1;
    let next = withChangedField(fields, ITEM_KIND_FIELD, API_KEY_KIND, FIELD_TEXT);
    next = withChangedField(next, API_KEY_FIELD, parts.key, FIELD_TEXT);
    next = withChangedField(next, API_SECRET_FIELD, parts.secret, FIELD_HIDDEN);
    return withChangedField(next, API_ENDPOINT_FIELD, parts.endpoint, FIELD_TEXT);
}

/** `withField`, but a no-op when the stored value is already this one - so an
 *  item opened and saved again keeps its field list exactly as it was. */
export function withChangedField<T extends { name: string; value: string; type: number }>(
    fields: readonly T[],
    name: string,
    value: string,
    type: number
): T[] {
    const existing = fields.find((field) => field.name === name);
    if ((existing?.value ?? "") === (value.trim() ? value : "")) return [...fields];
    return withField(fields, name, value, type);
}

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
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((shape) =>
        shape.test(password)
    ).length;
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

/**
 * Whether two passwords are close enough that one being learned gives away the
 * other.
 *
 * The rule the vault needs, and the reason it exists is worth stating: if the
 * master password is also the Polaris account password, then a phishing page,
 * a keylogger, a reused-password breach or an administrator with the sign-in
 * form is one credential away from the whole vault - and the vault is the thing
 * that was supposed to survive that. Two secrets that are one secret protect
 * nothing twice.
 *
 * Equality is the case that matters, but only after normalising: `Hunter2!` and
 * `hunter 2 !` are the same password with different typing, and a rule that
 * missed those would be a rule anybody can satisfy while changing nothing. So
 * both sides are lowercased and stripped to letters and digits before they are
 * compared.
 *
 * Containment counts too, from eight characters up - a master password that is
 * the account password with `-vault` on the end falls to the same one guess. The
 * floor is there because at three or four characters everything contains
 * everything.
 *
 * Nothing shorter is compared and nothing empty is: a half-typed box is not yet
 * an answer.
 */
export function passwordsTooAlike(left: string, right: string): boolean {
    const bare = (value: string) =>
        value
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
    const a = bare(left);
    const b = bare(right);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length < 8 || b.length < 8) return false;
    return a.includes(b) || b.includes(a);
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
    return (
        value
            .split(/\s+/)
            .map((token) => token.trim())
            // A leading "3." or "3)" is the list's numbering rather than part of the
            // code - but only when what is left still looks like one.
            .map((token) => {
                const numbered = /^\d{1,2}[.)]$/.test(token)
                    ? ""
                    : token.replace(/^\d{1,2}[.)]/, "");
                return numbered;
            })
            .filter((token) => token.length > 0)
    );
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
    const word =
        source
            .trim()
            .split(/[\s.\-_]+/)
            .filter(Boolean)[0] ?? "";
    if (!word) return "?";
    return word.slice(0, 2).toUpperCase();
}
