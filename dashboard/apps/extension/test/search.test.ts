/**
 * Finding a saved login by the little somebody remembers of its name.
 *
 * The box at the top of the popup, which is how anybody with more than a screenful
 * of logins reaches one. What is pinned here: a single letter is every login
 * carrying it rather than nothing (the list once went empty on the first
 * keystroke), a letter left out or turned around still finds what was meant, and
 * a name nothing in the vault carries answers nothing rather than whatever
 * shares a few letters with it.
 */

import { describe, expect, it } from "vitest";
import { searchLogins, type Searchable } from "../src/lib/search";

const login = (name: string, username: string | null = null): Searchable => ({ name, username });

const VAULT: readonly Searchable[] = [
    login("GitHub", "ada"),
    login("Amazon", "ada@example.test"),
    login("Serrano, Co", "billing"),
    login("Bank")
];

const names = (found: readonly Searchable[]): string[] => found.map((one) => one.name);

describe("a query of a single letter", () => {
    it("answers with the logins carrying it rather than with nothing", () => {
        expect(names(searchLogins(VAULT, "g"))).toContain("GitHub");
    });

    it("leaves out the ones that do not carry it", () => {
        expect(names(searchLogins(VAULT, "z"))).toEqual(["Amazon"]);
    });

    it("does not mind which case either side was written in", () => {
        expect(names(searchLogins(VAULT, "G"))).toContain("GitHub");
    });

    it("looks at the username as well as the name", () => {
        // "billing", which is the only place that letter appears for this one.
        expect(names(searchLogins(VAULT, "b"))).toContain("Serrano, Co");
    });
});

describe("a query with a letter left out or turned around", () => {
    it("still finds what somebody meant", () => {
        expect(names(searchLogins(VAULT, "githb"))).toContain("GitHub");
        expect(names(searchLogins(VAULT, "amazn"))).toContain("Amazon");
    });

    it("finds an entry by the part of its name somebody remembers", () => {
        // The surname, where the entry is filed under "Surname, Co".
        expect(names(searchLogins(VAULT, "serrano"))).toContain("Serrano, Co");
    });

    it("does not answer with something unrelated", () => {
        expect(names(searchLogins(VAULT, "githb"))).not.toContain("Bank");
    });

    it("answers nothing for a name the vault does not hold", () => {
        expect(searchLogins(VAULT, "netflix")).toEqual([]);
    });
});

describe("the list as a whole", () => {
    it("is everything when nothing has been typed", () => {
        expect(names(searchLogins(VAULT, ""))).toEqual(names(VAULT));
        expect(names(searchLogins(VAULT, "   "))).toEqual(names(VAULT));
    });

    it("puts the best guess first", () => {
        expect(names(searchLogins(VAULT, "github"))[0]).toBe("GitHub");
    });
});
