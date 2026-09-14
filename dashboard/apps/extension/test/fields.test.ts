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
import { findFields, isUsername, type FieldFacts } from "../src/lib/fields";

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
