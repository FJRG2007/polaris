/**
 * How one person reads mail, read back from what was stored.
 *
 * The rule worth a test is the one a stored blob breaks: it was written by a
 * version of Polaris with fewer of these fields in it, so a missing field is a
 * default rather than an absence, and nothing downstream should ever hold a
 * half-built preference. Everything here is about that - a null column, an older
 * blob, a hand-edited row - plus the one thing the strict schema exists for:
 * what a screen is allowed to send is not what a database is allowed to hold.
 */

import { describe, expect, it } from "vitest";
import {
    MAIL_PREF_DEFAULTS,
    mailPreferencesSchema,
    mailUndoLabel,
    parseMailPreferences,
    stringifyMailPreferences
} from "@polaris/core";

describe("reading somebody's mail preferences", () => {
    it("answers a column nobody has written with the whole shape", () => {
        expect(parseMailPreferences(null)).toEqual(MAIL_PREF_DEFAULTS);
        expect(parseMailPreferences(undefined)).toEqual(MAIL_PREF_DEFAULTS);
        expect(parseMailPreferences("")).toEqual(MAIL_PREF_DEFAULTS);
    });

    it("answers a blob written before a field existed with the whole shape", () => {
        // The case this is built for: a row stored by a Polaris that only knew
        // about the sort. Every other field is a default, not undefined.
        const held = parseMailPreferences('{"sort":"oldest"}');
        expect(held).toEqual({ ...MAIL_PREF_DEFAULTS, sort: "oldest" });
    });

    it("ignores a value nobody offers rather than storing it forward", () => {
        const held = parseMailPreferences(
            '{"sort":"sideways","markRead":"maybe","afterFiling":7,"undoSeconds":900}'
        );
        expect(held).toEqual(MAIL_PREF_DEFAULTS);
    });

    it("survives a column holding something that is not JSON at all", () => {
        expect(parseMailPreferences("{oops")).toEqual(MAIL_PREF_DEFAULTS);
        expect(parseMailPreferences("[1,2,3]")).toEqual(MAIL_PREF_DEFAULTS);
        expect(parseMailPreferences("null")).toEqual(MAIL_PREF_DEFAULTS);
    });

    it("writes the whole shape back, not only what differs from a default", () => {
        // What is read back next time is then what the screen showed, rather than
        // a mixture of one choice and whatever the defaults have become since.
        const chosen = { ...MAIL_PREF_DEFAULTS, markRead: "never" } as const;
        expect(parseMailPreferences(stringifyMailPreferences(chosen))).toEqual(chosen);
        expect(Object.keys(JSON.parse(stringifyMailPreferences(chosen))).sort()).toEqual([
            "afterFiling",
            "keys",
            "markRead",
            "sort",
            "undoSeconds"
        ]);
    });

    it("keeps the shortcuts somebody moved, and drops a stored map that collides", () => {
        const moved = parseMailPreferences('{"keys":{"archive":"y"}}');
        expect(moved.keys).toEqual({ archive: "y" });
        // Two commands on one key is a guess about which one was meant, so the
        // whole map goes back to the defaults rather than half of it.
        const clashing = parseMailPreferences('{"keys":{"archive":"s"}}');
        expect(clashing.keys).toEqual({});
    });
});

describe("what a screen is allowed to send", () => {
    it("takes a whole, valid answer", () => {
        expect(mailPreferencesSchema.safeParse(MAIL_PREF_DEFAULTS).success).toBe(true);
    });

    it("refuses a wait nobody offers, rather than storing it and defaulting it away", () => {
        expect(
            mailPreferencesSchema.safeParse({ ...MAIL_PREF_DEFAULTS, undoSeconds: 3600 }).success
        ).toBe(false);
        expect(
            mailPreferencesSchema.safeParse({ ...MAIL_PREF_DEFAULTS, undoSeconds: "10" }).success
        ).toBe(false);
    });

    it("refuses a half-filled form, where the stored blob would be forgiven one", () => {
        // The two are not the same job: one reads a request body, the other reads
        // what this deployment wrote.
        expect(mailPreferencesSchema.safeParse({ sort: "newest" }).success).toBe(false);
    });
});

describe("the undo window in words", () => {
    it("says what off actually means", () => {
        expect(mailUndoLabel(0)).toBe("Send immediately");
        expect(mailUndoLabel(10)).toBe("10 seconds");
    });
});
