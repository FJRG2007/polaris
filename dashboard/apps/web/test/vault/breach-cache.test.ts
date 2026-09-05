/**
 * The cache that keeps the corpus from being asked about the same password every
 * time an item is opened.
 *
 * The tests that matter are about what gets written down rather than about
 * speed: the key must not be the password, or anything that would confirm a
 * guess about it, and a stale answer must expire rather than harden into a
 * permanent "not breached".
 */

import { describe, expect, it } from "vitest";
import {
    BREACH_TTL_MS,
    breachKey,
    liveAnswers,
    passwordFingerprint,
    withAnswer,
    type BreachAnswer
} from "@/lib/breach-cache";

describe("what the key gives away", () => {
    it("is four hex characters and nothing else of the password", () => {
        const print = passwordFingerprint("correct horse battery staple");
        expect(print).toMatch(/^[0-9a-f]{4}$/);
        // The whole point: what lands on disk cannot be read back into a
        // password, and does not narrow a guess enough to confirm one.
        expect(print).not.toContain("horse");
    });

    it("is the same for the same password and different for another", () => {
        expect(passwordFingerprint("hunter2")).toBe(passwordFingerprint("hunter2"));
        expect(passwordFingerprint("hunter2")).not.toBe(passwordFingerprint("hunter3"));
    });

    it("files an answer under the item it belongs to", () => {
        expect(breachKey("item-1", "hunter2")).toBe(`item-1:${passwordFingerprint("hunter2")}`);
        expect(breachKey("item-2", "hunter2")).not.toBe(breachKey("item-1", "hunter2"));
    });
});

describe("how long an answer lasts", () => {
    const now = 1_700_000_000_000;

    it("keeps one inside the month", () => {
        const stored = { "a:0001": { count: 0, at: now - BREACH_TTL_MS + 1000 } };
        expect(liveAnswers(stored, now)).toEqual(stored);
    });

    it("drops one past it, so a new corpus is not ignored for ever", () => {
        const stored = { "a:0001": { count: 0, at: now - BREACH_TTL_MS - 1 } };
        expect(liveAnswers(stored, now)).toEqual({});
    });

    it("ignores junk left in the same key by something else", () => {
        const stored = { "a:0001": { at: now } } as unknown as Record<string, BreachAnswer>;
        expect(liveAnswers(stored, now)).toEqual({});
    });
});

describe("adding an answer", () => {
    const now = 1_700_000_000_000;

    it("records the count and the moment", () => {
        expect(withAnswer({}, "a:0001", 42, now)).toEqual({ "a:0001": { count: 42, at: now } });
    });

    it("expires the stale ones on the way past", () => {
        const stored = { "old:0001": { count: 1, at: now - BREACH_TTL_MS - 1 } };
        expect(withAnswer(stored, "new:0002", 0, now)).toEqual({
            "new:0002": { count: 0, at: now }
        });
    });

    it("drops the oldest rather than growing for ever", () => {
        const stored: Record<string, BreachAnswer> = {};
        for (let index = 0; index < 500; index += 1) {
            stored[`item-${index}:0001`] = { count: 0, at: now - 1000 + index };
        }
        const next = withAnswer(stored, "fresh:0002", 3, now);
        expect(Object.keys(next)).toHaveLength(500);
        expect(next["fresh:0002"]).toEqual({ count: 3, at: now });
        expect(next["item-0:0001"]).toBeUndefined();
    });
});
