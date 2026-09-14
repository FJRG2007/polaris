/**
 * Which box on a page is the username and which is the password.
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

/** Where the two boxes are, as positions in the list handed in. */
export interface FoundFields {
    /** The username box, or null when the page has none to offer. */
    readonly username: number | null;
    /** The password box, or null - a page can have a username and no password,
     *  which is the first step of a two-page sign-in. */
    readonly password: number | null;
}

/**
 * Find the pair, from the whole list of a page's inputs.
 *
 * The password is looked for first, because `type="password"` is a fact rather
 * than a guess, and the username is then looked for among the fields that belong
 * with it: the same form, or - when the page uses no form at all - the fields
 * written BEFORE it. That ordering is what stops the search box at the top of a
 * page being filled with somebody's email address.
 *
 * A password marked `new-password` is skipped: that is a sign-up asking for a
 * password to be invented, and putting the existing one there is both wrong and
 * the kind of wrong somebody only notices later.
 */
export function findFields(fields: readonly FieldFacts[]): FoundFields {
    const usable: number[] = [];
    for (const [index, field] of fields.entries()) {
        if (!field.usable || NEVER.has(field.type)) continue;
        usable.push(index);
    }

    const password =
        usable.find(
            (index) =>
                fields[index]?.type === "password" && fields[index]?.autocomplete !== "new-password"
        ) ?? null;

    const candidates =
        password === null
            ? usable
            : usable.filter((index) => {
                  const field = fields[index];
                  const pass = fields[password];
                  if (!field || !pass) return false;
                  // A form is the better answer where there is one; the order on
                  // the page is what is left when there is not.
                  return pass.form != null
                      ? field.form === pass.form
                      : usable.indexOf(index) < usable.indexOf(password);
              });

    const username = candidates.find((index) => isUsername(fields[index])) ?? null;
    return { username, password };
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
