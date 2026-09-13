import { describe, expect, it } from "vitest";
import {
    DEFAULT_TIMEOUT_MS,
    TIMEOUT_CHOICES,
    UNTIL_BROWSER_CLOSES,
    deadlineFrom,
    hasExpired,
    readTimeout
} from "../src/lib/lock";

/**
 * The arithmetic that decides when a vault locks itself.
 *
 * Worth its own tests because every mistake available here is silent: a deadline
 * an order of magnitude too long is an open vault on an unattended screen, and one
 * too short is a master password prompt every few minutes. Neither shows up as an
 * error anywhere.
 */

describe("readTimeout", () => {
    it("accepts every choice the popup offers", () => {
        for (const choice of TIMEOUT_CHOICES) {
            expect(readTimeout(choice.ms)).toBe(choice.ms);
        }
    });

    it("keeps 'when the browser closes' as a decision rather than treating it as unset", () => {
        expect(readTimeout(UNTIL_BROWSER_CLOSES)).toBe(UNTIL_BROWSER_CLOSES);
    });

    it("falls back to the default for anything it does not offer", () => {
        // A value edited by hand, a unit mix-up, and a duration nobody was offered.
        expect(readTimeout(7 * 60_000)).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout(-60_000)).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout(15)).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("falls back for anything that is not a finite number", () => {
        expect(readTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout(null)).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout("900000")).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TIMEOUT_MS);
        expect(readTimeout({ ms: 60_000 })).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("defaults to one of the shorter choices, never the longest", () => {
        const longest = Math.max(...TIMEOUT_CHOICES.map((choice) => choice.ms));
        expect(DEFAULT_TIMEOUT_MS).toBeLessThan(longest);
        expect(TIMEOUT_CHOICES.some((choice) => choice.ms === DEFAULT_TIMEOUT_MS)).toBe(true);
    });

    it("offers no way to keep the vault open past the browser session", () => {
        // The absence of a "never" is a security property, so it is asserted rather
        // than left to whoever edits the list next.
        expect(TIMEOUT_CHOICES.every((choice) => choice.ms >= 0)).toBe(true);
        expect(TIMEOUT_CHOICES.filter((choice) => choice.ms === UNTIL_BROWSER_CLOSES)).toHaveLength(
            1
        );
    });
});

describe("deadlineFrom", () => {
    it("counts from the moment of use, not from unlocking", () => {
        expect(deadlineFrom(1_000, 60_000)).toBe(61_000);
        expect(deadlineFrom(500_000, 60_000)).toBe(560_000);
    });

    it("has no deadline when the choice is the browser session", () => {
        expect(deadlineFrom(1_000, UNTIL_BROWSER_CLOSES)).toBeNull();
    });

    it("uses the default for a stored value it does not recognise", () => {
        expect(deadlineFrom(0, 7 * 60_000)).toBe(DEFAULT_TIMEOUT_MS);
    });
});

describe("hasExpired", () => {
    it("expires on the deadline and after it", () => {
        expect(hasExpired(1_000, 1_000)).toBe(true);
        expect(hasExpired(1_001, 1_000)).toBe(true);
    });

    it("does not expire before it", () => {
        expect(hasExpired(999, 1_000)).toBe(false);
    });

    it("never expires without a deadline", () => {
        expect(hasExpired(Number.MAX_SAFE_INTEGER, null)).toBe(false);
    });

    it("a clock that went backwards only ever delays the lock", () => {
        const until = deadlineFrom(1_000_000, 60_000);
        expect(hasExpired(1_000, until)).toBe(false);
    });
});
