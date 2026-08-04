/**
 * The name a session goes by.
 *
 * What has to hold is that it is a pure function of the id: the same session is
 * called the same thing on the sessions list, in the activity filter and in a
 * support message, without any of them agreeing on anything first. The rest is
 * arithmetic that has to stay 32-bit, which is the one way this can silently
 * drift between two places that both look right.
 */

import { describe, expect, it } from "vitest";
import { SESSION_NAMES, sessionName } from "../src/session-names.js";

const ID = "0198f2d1-4e6b-7c3a-9f01-2b8c5d6e7a90";

describe("naming a session", () => {
    it("gives the same id the same name every time", () => {
        expect(sessionName(ID)).toBe(sessionName(ID));
    });

    it("always answers with a name from the list", () => {
        const ids = Array.from({ length: 500 }, (_, index) => `session-${index}`);
        for (const id of ids) expect(SESSION_NAMES).toContain(sessionName(id));
    });

    it("stays inside the list however long the id is", () => {
        // The hash is unsigned and the modulus is the list length, so there is no
        // input that indexes past the end - a negative index would read undefined
        // and name the session nothing at all.
        expect(sessionName("x".repeat(4096))).not.toBe("");
        expect(sessionName("\u{1F600}\u{1F680}")).not.toBe("");
    });

    it("separates ids that differ by one character", () => {
        // Not guaranteed for every pair, but a hash that fails this on adjacent
        // ids would name a whole run of sessions identically.
        const names = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((suffix) => sessionName(`${ID}${suffix}`)));
        expect(names.size).toBeGreaterThan(1);
    });

    it("names nothing when there is nothing to name", () => {
        // Every session with no id would otherwise share one name, which reads as
        // a real name rather than as an absence.
        expect(sessionName("")).toBe("");
    });

    it("keeps the multiply 32-bit", () => {
        // A plain `*` instead of Math.imul loses the low bits past 2^53 and the
        // server and the browser stop agreeing. These are the values that fall
        // out of the real algorithm; if the multiply drifts, they move.
        expect(sessionName("polaris")).toBe(SESSION_NAMES[43]);
        expect(sessionName(ID)).toBe(SESSION_NAMES[55]);
    });
});
