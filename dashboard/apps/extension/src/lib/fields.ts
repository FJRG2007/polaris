/**
 * Which box on a page is the username, which is the password, and what the form
 * around them is for.
 *
 * Pure, and taking descriptions rather than elements, so the rules can be
 * asserted against the shapes real pages have without a DOM anywhere near them -
 * a login form written as a search box, a sign-up form whose password is marked
 * `new-password`, a page whose only text input is the site's search.
 *
 * **There is a second copy of these rules.** `typeIntoPage` in the worker is
 * serialized and handed to `browser.scripting.executeScript`, which means it
 * cannot see an import, a constant, or another function in its own file - so it
 * carries its own. That copy is the fallback for a page this extension has no
 * standing access to; this one is for the script that runs on a site somebody
 * has granted. The duplication is deliberate and bounded, and it is written down
 * here because the failure it invites - the two drifting apart - is invisible
 * until a form fills on one path and not the other.
 */

/** What a page's input looks like to a rule, with nothing of the DOM in it. */
export interface FieldFacts {
    /** The `type` attribute, lowercased. */
    readonly type: string;
    /** The `autocomplete` token, lowercased, or an empty string. */
    readonly autocomplete: string;
    /** Every word attached to the field - name, id, placeholder, title, label -
     *  joined and lowercased. */
    readonly words: string;
    /** Whether the field can be typed into at all: on screen, enabled, not
     *  read-only. */
    readonly usable: boolean;
    /** Which form it belongs to, as an identity that can be compared. Null for a
     *  field written outside any form, which is common enough to be the reason
     *  the ordering rule below exists. */
    readonly form: unknown;
    /** The `maxlength` attribute, or null where the page set none. A code box is
     *  short, and a box that takes one character is one digit of a code split
     *  across several. */
    readonly maxLength?: number | null;
    /** The `inputmode` attribute, lowercased, or an empty string. */
    readonly inputMode?: string;
}

/** The types a login is never typed into. */
const NEVER = new Set([
    "hidden",
    "file",
    "button",
    "image",
    "reset",
    "submit",
    "checkbox",
    "radio",
    "range",
    "color"
]);

/** Words that mean this box is for something else entirely. Checked before the
 *  identifier words, because "search" beats "user" in `user search`. */
const NOT_A_LOGIN = /search|captcha|find|query|coupon|voucher|discount|promo/i;

/** Words a username box tends to carry, in the languages this is likely to meet. */
const IDENTIFIER =
    /user|login|email|correo|usuario|e-?mail|account|cuenta|identifiant|benutzer|nome|phone|telefono|mobile/i;

/** Words that mean "the password you already have" - the box a sign-in fills. */
const CURRENT_WORDS = /current|old password|existing|actual|antigua|antiguo|vieja|viejo/i;

/** Words that mean "type it again", which is the box beside a new password
 *  rather than a second password of its own. */
const CONFIRM_WORDS =
    /confirm|confirma|repeat|repit|re-?type|re-?enter|again|otra vez|verify|verifica|match/i;

/** Words that mean "invent one now". */
const NEW_WORDS = /new|nueva|nuevo|create|crear|choose|elige|elegir|set up|registr|sign.?up/i;

/** Words a one-time code box carries. Narrow on purpose: a mark offering to type
 *  an authenticator's code into an unrelated box is worse than no mark at all. */
const ONE_TIME_WORDS =
    /one.?time|\b[th]?otp|2fa|two.?factor|two.?step|2.?step|authenticat|verification code|verify code|security code|login code|sign.?in code|c[oó]digo de verificaci[oó]n|c[oó]digo de seguridad|verificaci[oó]n en dos|dos pasos|\bmfa\b|passcode/i;

/** The bare word "code", which is a one-time code only on a box shaped like one:
 *  short, or asking for digits. On a long free-text box it is a gift card. */
const CODE_WORD = /\bcode\b|c[oó]digo|\btoken\b/i;

/** Codes that are not a second factor, whatever shape their box has. */
const NOT_A_ONE_TIME_CODE =
    /zip|postal|post.?code|country|area code|phone|tel[eé]fono|referr|invit|gift|card|cvc|cvv|tracking|coupon|promo/i;

/** The longest box a code goes in. Authenticators give six digits, some sites
 *  eight, and a box sized for more is asking for something else. */
const CODE_MOST = 8;

/** How many single-character boxes a split code comes in. */
const SPLIT_CODE = { least: 4, most: 8 } as const;

/** The types a short code is typed into. */
const CODE_TYPES = new Set(["text", "tel", "number"]);

/** Where the two boxes are, as positions in the list handed in. */
export interface FoundFields {
    /** The username box, or null when the page has none to offer. */
    readonly username: number | null;
    /** The password box, or null - a page can have a username and no password,
     *  which is the first step of a two-page sign-in. */
    readonly password: number | null;
}

/**
 * What the form in front of somebody is for.
 *
 * `signin` is a password being recalled, `signup` one being invented, `change`
 * both at once, and `none` a page with no password box at all - which is still
 * worth naming, because the first page of a two-page sign-in looks like that and
 * the username on it is still worth offering.
 */
export type FormPurpose = "signin" | "signup" | "change" | "none";

/** Every box this extension has something to offer for, and what to offer. */
export interface PageFields extends FoundFields {
    /** The box a new password is invented in, on a sign-up or a change form. */
    readonly newPassword: number | null;
    /** The box that same new password is typed into again. */
    readonly confirmPassword: number | null;
    /** The box an authenticator's six digits go in - the first of them, where
     *  the page splits the code into one box per digit. */
    readonly oneTimeCode: number | null;
    /** Every box the code goes in, in order: one for an ordinary code box,
     *  one per digit for a split one, none when the page asks for no code. */
    readonly oneTimeCodeBoxes: readonly number[];
    readonly purpose: FormPurpose;
}

/** What one password box on the page turned out to be. */
type PasswordRole = "current" | "new" | "confirm" | "unknown";

/** Three unlabelled password boxes, in the order they are always written in. */
const BY_COUNT: readonly PasswordRole[] = ["current", "new", "confirm"];

/**
 * Find the pair, from the whole list of a page's inputs.
 *
 * Kept as the narrow question the fill path asks - which two boxes does a saved
 * login go into - and answered out of `readForm`, so the two can never disagree
 * about what a sign-up form is.
 */
export function findFields(fields: readonly FieldFacts[]): FoundFields {
    const { username, password } = readForm(fields);
    return { username, password };
}

/**
 * Read the whole form: which password is which, and what it is for.
 *
 * The password boxes are found first, because `type="password"` is a fact rather
 * than a guess, and their roles come from what the page says about them - the
 * `autocomplete` token first, then the words around them. What is left over is
 * settled by how many there are, which is the rule that covers the pages that
 * label nothing at all: two password boxes are a password and its confirmation,
 * three are the current one followed by both.
 *
 * The username is then looked for among the fields that belong with the password
 * it goes with: the same form, or - when the page uses no form at all - the
 * fields written BEFORE it. That ordering is what stops the search box at the top
 * of a page being filled with somebody's email address.
 *
 * A new password is never reported as the one to fill. Putting the existing
 * password there is both wrong and the kind of wrong somebody only notices later,
 * when they cannot sign in with the password they believe they chose.
 */
export function readForm(fields: readonly FieldFacts[]): PageFields {
    const usable: number[] = [];
    for (const [index, field] of fields.entries()) {
        if (!field.usable || NEVER.has(field.type)) continue;
        usable.push(index);
    }

    const passwords = usable.filter((index) => fields[index]?.type === "password");
    // One form's worth of them. A page with a sign-in and a sign-up side by side
    // has two sets, and counting them together reads the pair as a change form.
    const first = passwords[0];
    const group =
        first === undefined
            ? []
            : passwords.filter((index) => fields[index]?.form === fields[first]?.form);
    const roles = settleRoles(group.map((index) => roleOf(fields[index])));
    const roleAt = (role: PasswordRole): number | null => {
        const where = roles.indexOf(role);
        return where === -1 ? null : (group[where] ?? null);
    };

    const current = roleAt("current");
    const newPassword = roleAt("new");
    const confirmPassword = roleAt("confirm");

    // The name goes with whichever password this form is actually about: the one
    // being recalled where there is one, the one being invented otherwise.
    const anchor = current ?? newPassword;
    const candidates =
        anchor === null
            ? usable
            : usable.filter((index) => {
                  const field = fields[index];
                  const pass = fields[anchor];
                  if (!field || !pass) return false;
                  // A form is the better answer where there is one; the order on
                  // the page is what is left when there is not.
                  return pass.form != null
                      ? field.form === pass.form
                      : usable.indexOf(index) < usable.indexOf(anchor);
              });

    // The code box first, so a box labelled "login code" is not then read as the
    // username because it says "login".
    const single = usable.find((index) => isOneTimeCode(fields[index]));
    const username =
        candidates.find((index) => index !== single && isUsername(fields[index])) ?? null;
    const oneTimeCodeBoxes =
        single !== undefined ? [single] : splitCode(fields, usable, [username, current, newPassword]);
    const oneTimeCode = oneTimeCodeBoxes[0] ?? null;

    const purpose: FormPurpose =
        current !== null && newPassword !== null
            ? "change"
            : newPassword !== null
              ? "signup"
              : current !== null
                ? "signin"
                : "none";

    return {
        username,
        password: current,
        newPassword,
        confirmPassword,
        oneTimeCode,
        oneTimeCodeBoxes,
        purpose
    };
}

/**
 * A code split into one box per digit, which is how a good share of sites ask
 * for it now: a row of four to eight boxes that each take one character, side by
 * side in the same form. None of them says "code" on its own - most say nothing
 * at all - so the row is the evidence, and a row is required: two one-character
 * boxes are an initial and a suffix, not a code.
 *
 * Boxes already taken as the username or a password are never part of it.
 */
function splitCode(
    fields: readonly FieldFacts[],
    usable: readonly number[],
    taken: readonly (number | null)[]
): number[] {
    let run: number[] = [];
    const settle = (): number[] | null =>
        run.length >= SPLIT_CODE.least && run.length <= SPLIT_CODE.most ? run : null;
    for (const index of usable) {
        const field = fields[index];
        const digit =
            field !== undefined &&
            !taken.includes(index) &&
            field.maxLength === 1 &&
            CODE_TYPES.has(field.type) &&
            !NOT_A_LOGIN.test(field.words);
        const last = run[run.length - 1];
        if (digit && (last === undefined || fields[last]?.form === field.form)) {
            run.push(index);
            continue;
        }
        const found = settle();
        if (found) return found;
        run = digit ? [index] : [];
    }
    return settle() ?? [];
}

/** What one password box says about itself, before its neighbours are counted. */
function roleOf(field: FieldFacts | undefined): PasswordRole {
    if (!field) return "unknown";
    const token = field.autocomplete;
    if (token === "current-password") return "current";
    if (token === "new-password") return CONFIRM_WORDS.test(field.words) ? "confirm" : "new";
    if (CURRENT_WORDS.test(field.words)) return "current";
    if (CONFIRM_WORDS.test(field.words)) return "confirm";
    if (NEW_WORDS.test(field.words)) return "new";
    return "unknown";
}

/**
 * Give the unlabelled boxes a role, from how many there are and where they sit.
 *
 * A page that labels nothing is the common case rather than the exception: one
 * box is a sign-in, two are a password and its confirmation, three are the
 * current one followed by both. Where the page DID label something, an
 * unlabelled box before the new password is the current one and an unlabelled
 * box after it is the confirmation, which is the order these are written in
 * everywhere - and a role already filled is not filled twice.
 */
function settleRoles(said: readonly PasswordRole[]): PasswordRole[] {
    if (said.length === 0) return [];
    if (said.every((role) => role === "unknown")) {
        if (said.length === 1) return ["current"];
        if (said.length === 2) return ["new", "confirm"];
        return said.map((_, index) => BY_COUNT[index] ?? "unknown");
    }

    const settled = [...said];
    const firstNew = settled.indexOf("new");
    for (const [index, role] of settled.entries()) {
        if (role !== "unknown") continue;
        const wanted: PasswordRole = firstNew !== -1 && index > firstNew ? "confirm" : "current";
        settled[index] = settled.includes(wanted) ? "unknown" : wanted;
    }
    return settled;
}

/** Whether this box is the one a username goes in. */
export function isUsername(field: FieldFacts | undefined): boolean {
    if (!field) return false;
    const token = field.autocomplete;
    // The page said so itself, which outranks every guess below it.
    if (token === "username" || token === "email") return true;
    // And a page that named it something else entirely has been believed.
    if (token !== "off" && token !== "") return false;
    if (!["text", "email", "tel", "number"].includes(field.type)) return false;
    if (NOT_A_LOGIN.test(field.words)) return false;
    return IDENTIFIER.test(field.words) || field.type === "email";
}

/** Whether this box is where an authenticator's code is typed. */
export function isOneTimeCode(field: FieldFacts | undefined): boolean {
    if (!field) return false;
    if (field.autocomplete === "one-time-code") return true;
    if (field.autocomplete !== "" && field.autocomplete !== "off") return false;
    if (!CODE_TYPES.has(field.type)) return false;
    if (NOT_A_LOGIN.test(field.words) || NOT_A_ONE_TIME_CODE.test(field.words)) return false;
    if (ONE_TIME_WORDS.test(field.words)) return true;
    // "Code" alone, on a box shaped like one: short enough for a code, or
    // asking for digits. Never a one-character box, which is a digit of a split
    // code and is found as a row instead.
    if (!CODE_WORD.test(field.words)) return false;
    const length = field.maxLength ?? null;
    const short = length !== null && length >= 4 && length <= CODE_MOST;
    const digits = field.inputMode === "numeric" || field.type === "tel" || field.type === "number";
    return length !== 1 && (short || digits);
}
