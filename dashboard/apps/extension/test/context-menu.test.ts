/**
 * Which of Polaris's right-click entries a box gets.
 *
 * A password box is where a new password is made; any other box is where the
 * code or an email goes. Offering the generator on a search box is an entry
 * that types a password somewhere it will be read.
 */

import { describe, expect, it } from "vitest";
import { MENU, MENU_ENTRIES, visibleEntries } from "../src/lib/context-menu";

describe("the right-click entries", () => {
    it("offers the login and a new password on a password box", () => {
        expect(visibleEntries("password")).toEqual({
            [MENU.fill]: true,
            [MENU.generate]: true,
            [MENU.code]: false,
            [MENU.email]: false
        });
    });

    it("offers the login, the code and your email on any other box", () => {
        expect(visibleEntries("text")).toEqual({
            [MENU.fill]: true,
            [MENU.generate]: false,
            [MENU.code]: true,
            [MENU.email]: true
        });
    });

    it("has an answer for every entry it creates", () => {
        for (const target of ["password", "text"] as const) {
            const shown = visibleEntries(target);
            for (const entry of MENU_ENTRIES) expect(typeof shown[entry.id]).toBe("boolean");
        }
    });
});
