/**
 * Picking the username and password boxes out of a page.
 *
 * Every case here is a shape real pages have, and most of them are ways of
 * getting it wrong that cost something: a password typed into a search box is a
 * password in somebody's browser history, and a sign-up form filled with the
 * existing password is an account created with a password its owner thinks is
 * new.
 */

import { describe, expect, it } from "vitest";
import { findFields, isOneTimeCode, isUsername, readForm, type FieldFacts } from "../src/lib/fields";

/** An input, with the defaults of an ordinary visible text box. */
function field(over: Partial<FieldFacts> = {}): FieldFacts {
    return {
        type: "text",
        autocomplete: "",
        words: "",
        usable: true,
        form: null,
        ...over
    };
}

const FORM = { id: "login" };

describe("finding the pair on a page", () => {
    it("takes the password by its type and the username beside it", () => {
        const found = findFields([
            field({ words: "username", form: FORM }),
            field({ type: "password", form: FORM })
        ]);
        expect(found).toEqual({ username: 0, password: 1 });
    });

    it("does not read the search box at the top of the page as the username", () => {
        // The case the ordering rule exists for: no form anywhere, and a search
        // box written above the login. Both are plain text inputs.
        const found = findFields([
            field({ words: "site search" }),
            field({ words: "email address" }),
            field({ type: "password" })
        ]);
        expect(found.username).toBe(1);
    });

    it("leaves a sign-up's new password alone", () => {
        // Filling this is how somebody ends up with an account whose password is
        // not the one they think they just chose.
        const found = findFields([
            field({ words: "email" }),
            field({ type: "password", autocomplete: "new-password" })
        ]);
        expect(found.password).toBeNull();
    });

    it("ignores boxes nobody can type into", () => {
        const found = findFields([
            field({ words: "username", usable: false }),
            field({ type: "hidden", words: "username" }),
            field({ type: "password" })
        ]);
        expect(found.username).toBeNull();
        expect(found.password).toBe(2);
    });

    it("keeps to the password's own form when the page has forms", () => {
        // Two logins on one page - a sign-in and a sign-up side by side - and the
        // username of one must not be filled for the password of the other.
        const other = { id: "signup" };
        const found = findFields([
            field({ words: "username", form: other }),
            field({ words: "username", form: FORM }),
            field({ type: "password", form: FORM })
        ]);
        expect(found.username).toBe(1);
    });

    it("finds a username on a page that asks for it first", () => {
        // Two-page sign-ins ask for the name, then the password on the next
        // screen. A page with no password box still has something to fill.
        const found = findFields([field({ words: "email" })]);
        expect(found).toEqual({ username: 0, password: null });
    });

    it("has nothing to say about a page with no inputs", () => {
        expect(findFields([])).toEqual({ username: null, password: null });
    });
});

describe("what the form is for", () => {
    it("reads one password box as somebody signing in", () => {
        const form = readForm([field({ words: "email" }), field({ type: "password" })]);
        expect(form.purpose).toBe("signin");
        expect(form).toMatchObject({ username: 0, password: 1, newPassword: null });
    });

    it("reads two unlabelled password boxes as a password and its confirmation", () => {
        // The shape most sign-up forms actually have: nothing says "new", there
        // are simply two of them.
        const form = readForm([
            field({ words: "email", form: FORM }),
            field({ type: "password", form: FORM }),
            field({ type: "password", form: FORM })
        ]);
        expect(form).toMatchObject({
            purpose: "signup",
            password: null,
            newPassword: 1,
            confirmPassword: 2
        });
    });

    it("reads three of them as a password being changed", () => {
        const form = readForm([
            field({ type: "password", form: FORM }),
            field({ type: "password", form: FORM }),
            field({ type: "password", form: FORM })
        ]);
        expect(form).toMatchObject({
            purpose: "change",
            password: 0,
            newPassword: 1,
            confirmPassword: 2
        });
    });

    it("believes the page over the count when it labels its boxes", () => {
        const form = readForm([
            field({ type: "password", autocomplete: "current-password", form: FORM }),
            field({ type: "password", autocomplete: "new-password", form: FORM })
        ]);
        expect(form).toMatchObject({ purpose: "change", password: 0, newPassword: 1 });
    });

    it("reads the words around a box when there is no autocomplete on it", () => {
        const form = readForm([
            field({ type: "password", words: "current password", form: FORM }),
            field({ type: "password", words: "nueva contraseña", form: FORM }),
            field({ type: "password", words: "repite la contraseña", form: FORM })
        ]);
        expect(form).toMatchObject({ purpose: "change", password: 0, newPassword: 1, confirmPassword: 2 });
    });

    it("reads a box followed by its confirmation as a password being set", () => {
        // "Set your password to activate your account": the first box says only
        // how long it must be, the second that it repeats the first.
        const form = readForm([
            field({ type: "password", words: "min. 8 characters", form: FORM }),
            field({ type: "password", words: "repeat password", form: FORM })
        ]);
        expect(form).toMatchObject({
            purpose: "signup",
            password: null,
            newPassword: 0,
            confirmPassword: 1
        });
    });

    it("finds where somebody's own name goes, and never in the username box", () => {
        const form = readForm([
            field({ words: "first name", form: FORM }),
            field({ words: "apellidos", form: FORM }),
            field({ words: "nombre de usuario", form: FORM }),
            field({ type: "password", autocomplete: "new-password", form: FORM })
        ]);
        expect(form).toMatchObject({ givenName: 0, familyName: 1, fullName: null, username: 2 });

        const whole = readForm([field({ autocomplete: "name" }), field({ words: "email", type: "email" })]);
        expect(whole).toMatchObject({ fullName: 0, username: 1 });
    });

    it("never offers to fill a new password with the saved one", () => {
        const form = readForm([
            field({ words: "email", form: FORM }),
            field({ type: "password", autocomplete: "new-password", form: FORM })
        ]);
        expect(form.password).toBeNull();
        expect(form.newPassword).toBe(1);
    });

    it("does not count a sign-in and a sign-up on one page as a change form", () => {
        // Two forms side by side, which is three password boxes on the page and
        // nothing whatever to do with changing one.
        const signup = { id: "signup" };
        const form = readForm([
            field({ type: "password", form: FORM }),
            field({ type: "password", form: signup }),
            field({ type: "password", form: signup })
        ]);
        expect(form).toMatchObject({ purpose: "signin", password: 0, newPassword: null });
    });

    it("finds the box an authenticator's code goes in", () => {
        const form = readForm([field({ autocomplete: "one-time-code" })]);
        expect(form.oneTimeCode).toBe(0);
        expect(form.oneTimeCodeBoxes).toEqual([0]);
    });

    it("does not read a box labelled 'login code' as the username", () => {
        // It says "login", which is an identifier word; it is the code box.
        const form = readForm([field({ words: "login code", maxLength: 6 })]);
        expect(form).toMatchObject({ username: null, oneTimeCode: 0 });
    });

    it("finds a code split into one box per digit", () => {
        const digit = { maxLength: 1, inputMode: "numeric", form: FORM };
        const form = readForm([
            field({ words: "search" }),
            ...Array.from({ length: 6 }, () => field(digit)),
            field({ type: "submit" })
        ]);
        expect(form.oneTimeCodeBoxes).toEqual([1, 2, 3, 4, 5, 6]);
        expect(form.oneTimeCode).toBe(1);
    });

    it("does not take two one-character boxes for a code", () => {
        const form = readForm([field({ maxLength: 1 }), field({ maxLength: 1 })]);
        expect(form.oneTimeCodeBoxes).toEqual([]);
        expect(form.oneTimeCode).toBeNull();
    });
});

describe("whether a box is for a one-time code", () => {
    it("believes the page when it says so", () => {
        expect(isOneTimeCode(field({ autocomplete: "one-time-code" }))).toBe(true);
    });

    it("reads the words a code box carries", () => {
        expect(isOneTimeCode(field({ words: "verification code" }))).toBe(true);
        expect(isOneTimeCode(field({ words: "authenticator app code" }))).toBe(true);
        expect(isOneTimeCode(field({ words: "one-time password" }))).toBe(true);
        expect(isOneTimeCode(field({ words: "totp" }))).toBe(true);
        expect(isOneTimeCode(field({ words: "otp_code" }))).toBe(true);
        expect(isOneTimeCode(field({ words: "two-step verification" }))).toBe(true);
        expect(isOneTimeCode(field({ words: "código de seguridad" }))).toBe(true);
    });

    it("takes a bare 'code' only on a box shaped like one", () => {
        // What most sign-in second steps actually say.
        expect(isOneTimeCode(field({ words: "code", maxLength: 6 }))).toBe(true);
        expect(isOneTimeCode(field({ words: "enter the code", inputMode: "numeric" }))).toBe(true);
        expect(isOneTimeCode(field({ type: "tel", words: "code" }))).toBe(true);
        // A long free-text box that says "code" is something else.
        expect(isOneTimeCode(field({ words: "code" }))).toBe(false);
        expect(isOneTimeCode(field({ words: "code", maxLength: 40 }))).toBe(false);
    });

    it("never takes a postal, phone or card code", () => {
        expect(isOneTimeCode(field({ words: "postal code", maxLength: 5 }))).toBe(false);
        expect(isOneTimeCode(field({ words: "zip code", inputMode: "numeric" }))).toBe(false);
        expect(isOneTimeCode(field({ words: "area code", maxLength: 4 }))).toBe(false);
        expect(isOneTimeCode(field({ words: "card security code", maxLength: 4 }))).toBe(false);
        expect(isOneTimeCode(field({ words: "gift card code", maxLength: 8 }))).toBe(false);
    });

    it("leaves an ordinary box alone", () => {
        // A mark offering to type an authenticator's code into a discount box is
        // worse than no mark at all.
        expect(isOneTimeCode(field({ words: "coupon code" }))).toBe(false);
        expect(isOneTimeCode(field({ words: "email" }))).toBe(false);
        expect(isOneTimeCode(field({ type: "password", words: "code" }))).toBe(false);
    });
});

describe("whether a box is for a username", () => {
    it("believes the page when it says so", () => {
        expect(isUsername(field({ autocomplete: "username", words: "" }))).toBe(true);
        expect(isUsername(field({ autocomplete: "email", words: "" }))).toBe(true);
    });

    it("believes the page when it says something else", () => {
        // `autocomplete="postal-code"` on a box named "user code" is a page being
        // explicit, and guessing over it is guessing against evidence.
        expect(isUsername(field({ autocomplete: "postal-code", words: "user code" }))).toBe(false);
    });

    it("refuses a search box however it is named", () => {
        expect(isUsername(field({ words: "user search" }))).toBe(false);
        expect(isUsername(field({ words: "find your account" }))).toBe(false);
    });

    it("takes an email box on the type alone", () => {
        expect(isUsername(field({ type: "email", words: "" }))).toBe(true);
    });

    it("reads the languages a login is written in", () => {
        expect(isUsername(field({ words: "correo electronico" }))).toBe(true);
        expect(isUsername(field({ words: "nombre de usuario" }))).toBe(true);
        expect(isUsername(field({ words: "benutzername" }))).toBe(true);
    });

    it("says no to a box with nothing to go on", () => {
        expect(isUsername(field({ words: "" }))).toBe(false);
        expect(isUsername(undefined)).toBe(false);
    });
});
