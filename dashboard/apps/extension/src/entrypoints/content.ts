import type { FillPayload } from "@/lib/messages";

/**
 * Typing into the form, and nothing else.
 *
 * This is the only part of the extension that runs inside a page, so it is
 * written on the assumption that the page is hostile: it holds no key, no token
 * and no list of items, it never asks the vault for anything, and it cannot
 * decide which item to use. It waits to be handed two strings and puts them in
 * the two fields it decided were the login - after the worker has already
 * checked that this page is one the item was saved for.
 *
 * **It does not fill on page load.** That is a setting Bitwarden ships off by
 * default and documents the reason for: a page that arranges the right fields
 * gets a password without anybody choosing to give it one. Filling here always
 * follows somebody pressing something.
 *
 * The heuristics are the small, boring end of the ones a mature password manager
 * uses - autocomplete tokens first because they are the author telling you what
 * the field is, then the input type, then the names and labels. What is
 * deliberately absent is a regular expression over the page, closed shadow roots
 * and cross-frame walking: each of those is a cost that has to be paid for with a
 * measured need, and none of them is needed to fill an ordinary login form.
 */

/** Fields that are never a login field, whatever they are called. */
const NEVER = new Set(["hidden", "file", "button", "image", "reset", "submit", "checkbox", "radio", "range", "color"]);

/** Words that mean this box is for finding things, not for signing in. */
const NOT_A_LOGIN = /search|captcha|find|query|coupon|voucher|discount|promo/i;

/** Words that name the box somebody's name goes in, in the languages a form is usually written in. */
const IDENTIFIER =
    /user|login|email|correo|usuario|e-?mail|account|cuenta|identifiant|benutzer|nome|phone|telefono|mobile/i;

/** Everything about a field that might say what it is for. */
function describe(field: HTMLInputElement): string {
    const labels = [
        field.name,
        field.id,
        field.placeholder,
        field.title,
        field.getAttribute("aria-label") ?? "",
        field.labels?.[0]?.textContent ?? ""
    ];
    return labels.join(" ").toLowerCase();
}

/** Whether somebody could actually type in it. */
function usable(field: HTMLInputElement): boolean {
    if (NEVER.has(field.type)) return false;
    if (field.disabled || field.readOnly) return false;
    const box = field.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    return getComputedStyle(field).visibility !== "hidden";
}

/**
 * The password box to fill, and the box for the name that goes with it.
 *
 * The password is found first because it is the unambiguous one: `type="password"`
 * is not a guess. The identifier is then looked for in the same form, and among
 * the fields BEFORE the password when there is no form - which is the order a
 * login form is written in, and the reason a search box at the top of the page is
 * not mistaken for the username.
 */
function loginFields(): { user: HTMLInputElement | null; pass: HTMLInputElement | null } {
    const inputs = [...document.querySelectorAll("input")].filter(usable);
    const passwords = inputs.filter(
        (field) => field.type === "password" && field.autocomplete !== "new-password"
    );
    const pass = passwords[0] ?? null;

    const candidates = pass
        ? inputs.filter((field) =>
              pass.form ? field.form === pass.form : inputs.indexOf(field) < inputs.indexOf(pass)
          )
        : inputs;

    const named = (field: HTMLInputElement): boolean => {
        const token = field.autocomplete?.toLowerCase() ?? "";
        if (token === "username" || token === "email") return true;
        if (token === "off" || token === "") {
            if (!["text", "email", "tel", "number"].includes(field.type)) return false;
            const words = describe(field);
            if (NOT_A_LOGIN.test(words)) return false;
            return IDENTIFIER.test(words) || field.type === "email";
        }
        return false;
    };

    const user = candidates.find(named) ?? null;
    return { user, pass };
}

/**
 * Put a value in and tell the page it happened.
 *
 * A form built with a framework holds its own copy of what it thinks the field
 * says, so a value written straight to `value` is one the page does not know
 * about and throws away on submit. Setting it through the property descriptor and
 * then raising both events is what makes the page agree.
 */
function type(field: HTMLInputElement, value: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    field.focus();
    descriptor?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
}

export default defineContentScript({
    matches: ["<all_urls>"],
    runAt: "document_idle",
    main() {
        browser.runtime.onMessage.addListener((raw, sender) => {
            // Only from this extension's own worker. A page cannot post a message
            // that arrives with our id on it, and one that tries gets nothing.
            if (sender.id !== browser.runtime.id) return undefined;
            const message = raw as { kind?: string; payload?: FillPayload };
            if (message.kind !== "fill" || !message.payload) return undefined;

            const { user, pass } = loginFields();
            if (message.payload.username && user) type(user, message.payload.username);
            if (message.payload.password && pass) type(pass, message.payload.password);
            // What was actually filled, so the popup can say "no form here"
            // instead of appearing to work.
            return Promise.resolve({ user: Boolean(user), pass: Boolean(pass) });
        });
    }
});
