/**
 * Going quiet, for a while or for good.
 *
 * The distinction the tests are really about: null with `muted` set means "until
 * I turn it back on", and that is a different state from a silence that lapses.
 * Collapsing them - by storing a date a hundred years out, say - would leave the
 * screen unable to say which one somebody chose, and it would say "quiet until
 * 2126" at them.
 *
 * The other one is that a lapsed mute is worked out on read. Nothing runs to
 * clear the flag, so a silence that has expired has to stop being a silence the
 * moment it is asked about rather than the moment a job next runs.
 */

import { describe, expect, it } from "vitest";
import {
    MUTE_DURATIONS,
    MUTE_FOREVER,
    MUTE_LABELS,
    muteEndsAt,
    muteInForce,
    muteSchema
} from "@polaris/core";

const now = new Date("2026-08-15T12:00:00.000Z");

describe("choosing a length", () => {
    it("offers the set every messenger settled on", () => {
        expect([...MUTE_DURATIONS]).toEqual([15, 60, 180, 480, 1440]);
    });

    it("names each of them, including the one with no end", () => {
        for (const minutes of [...MUTE_DURATIONS, MUTE_FOREVER]) {
            expect(MUTE_LABELS[minutes]).toBeTruthy();
        }
        expect(MUTE_LABELS[MUTE_FOREVER]).toContain("turn it back on");
    });

    it("works out when the quiet ends", () => {
        expect(muteEndsAt(60, now)?.toISOString()).toBe("2026-08-15T13:00:00.000Z");
        expect(muteEndsAt(1440, now)?.toISOString()).toBe("2026-08-16T12:00:00.000Z");
    });

    it("has no end for the one with no end", () => {
        // Not a date far away: a date is a lapse waiting to happen, and the
        // screen could not tell the two apart afterwards.
        expect(muteEndsAt(MUTE_FOREVER, now)).toBeNull();
    });
});

describe("what the server will accept", () => {
    it("takes the offered lengths and no end", () => {
        const channelId = "0193b0f0-0000-7000-8000-000000000001";
        for (const minutes of [...MUTE_DURATIONS, MUTE_FOREVER, null]) {
            expect(muteSchema.safeParse({ channelId, minutes }).success).toBe(true);
        }
    });

    it("refuses a length nobody was offered", () => {
        // "Muted for 527 minutes" is not a state any screen could describe
        // afterwards, so it is not a state to store.
        const channelId = "0193b0f0-0000-7000-8000-000000000001";
        expect(muteSchema.safeParse({ channelId, minutes: 527 }).success).toBe(false);
        expect(muteSchema.safeParse({ channelId, minutes: -60 }).success).toBe(false);
    });
});

describe("whether a stored mute still holds", () => {
    it("holds with no end, forever", () => {
        expect(muteInForce({ muted: true, mutedUntil: null }, now)).toBe(true);
    });

    it("holds until its end", () => {
        expect(
            muteInForce({ muted: true, mutedUntil: "2026-08-15T12:30:00.000Z" }, now)
        ).toBe(true);
    });

    it("stops the moment it is asked about, with nothing having run", () => {
        expect(
            muteInForce({ muted: true, mutedUntil: "2026-08-15T11:59:00.000Z" }, now)
        ).toBe(false);
    });

    it("does not hold at all when it was never set", () => {
        expect(muteInForce({ muted: false, mutedUntil: null }, now)).toBe(false);
        // A leftover end with the flag cleared is still not a mute.
        expect(
            muteInForce({ muted: false, mutedUntil: "2026-08-16T12:00:00.000Z" }, now)
        ).toBe(false);
    });
});
