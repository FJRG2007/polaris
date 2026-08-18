/**
 * How long a room makes somebody wait between messages.
 *
 * The arithmetic is shared between the two places that have to agree: the send
 * path refuses on it, and the line above the composer counts down on it. A
 * client that said "you can send now" a second before the server refused would
 * make a liar of one of them, and the one people would blame is the screen.
 *
 * The rounding is the part worth pinning. Half a second left is still a wait -
 * telling somebody zero and then refusing them is the single answer worse than
 * the truth - so it rounds up, and the countdown reaches zero at the moment the
 * server starts saying yes rather than a moment before.
 */

import { describe, expect, it } from "vitest";
import { CHAT_SLOWMODE_STEPS, slowmodeSpoken, slowmodeWait } from "@polaris/core";

const at = (iso: string) => new Date(iso);

describe("how long is left", () => {
    it("is nothing at all when the room has no wait", () => {
        expect(
            slowmodeWait({
                slowmode: 0,
                lastSentAt: at("2026-01-01T00:00:00Z"),
                now: at("2026-01-01T00:00:01Z")
            })
        ).toBe(0);
    });

    it("is nothing for somebody who has not said anything yet", () => {
        // Arriving in a slowed room and being made to wait before the first word
        // would be a room nobody joins.
        expect(
            slowmodeWait({ slowmode: 30, lastSentAt: null, now: at("2026-01-01T00:00:00Z") })
        ).toBe(0);
    });

    it("is the whole wait immediately after sending", () => {
        expect(
            slowmodeWait({
                slowmode: 30,
                lastSentAt: at("2026-01-01T00:00:00Z"),
                now: at("2026-01-01T00:00:00Z")
            })
        ).toBe(30);
    });

    it("counts down as time passes", () => {
        expect(
            slowmodeWait({
                slowmode: 30,
                lastSentAt: at("2026-01-01T00:00:00Z"),
                now: at("2026-01-01T00:00:20Z")
            })
        ).toBe(10);
    });

    it("rounds a part-second up, because a part-second is still a wait", () => {
        expect(
            slowmodeWait({
                slowmode: 30,
                lastSentAt: at("2026-01-01T00:00:00.000Z"),
                now: at("2026-01-01T00:00:29.500Z")
            })
        ).toBe(1);
    });

    it("is zero once the wait is served, and never negative", () => {
        expect(
            slowmodeWait({
                slowmode: 30,
                lastSentAt: at("2026-01-01T00:00:00Z"),
                now: at("2026-01-01T00:05:00Z")
            })
        ).toBe(0);
    });

    it("is never longer than the wait itself, however wrong a clock is", () => {
        // Two machines mean two clocks. Without the ceiling, a message stamped
        // an hour in the future holds somebody for an hour in a room set to
        // thirty seconds - and nothing on screen would explain why.
        expect(
            slowmodeWait({
                slowmode: 30,
                lastSentAt: at("2026-01-01T00:01:00Z"),
                now: at("2026-01-01T00:00:00Z")
            })
        ).toBe(30);
    });
});

describe("saying it out loud", () => {
    it("uses seconds under a minute", () => {
        expect(slowmodeSpoken(5)).toBe("5 seconds");
        expect(slowmodeSpoken(1)).toBe("a second");
    });

    it("uses minutes over one", () => {
        expect(slowmodeSpoken(60)).toBe("a minute");
        expect(slowmodeSpoken(300)).toBe("5 minutes");
    });

    it("uses hours at the top of the ladder", () => {
        expect(slowmodeSpoken(3600)).toBe("an hour");
        expect(slowmodeSpoken(21_600)).toBe("6 hours");
    });

    it("has something to say for every step offered", () => {
        // The settings menu writes every one of these out, so a step with no
        // sentence for it would be a blank row somebody could choose.
        for (const step of CHAT_SLOWMODE_STEPS) {
            if (step === 0) continue;
            expect(slowmodeSpoken(step)).toMatch(/[a-z]/);
        }
    });
});

describe("the steps themselves", () => {
    it("starts at off", () => {
        expect(CHAT_SLOWMODE_STEPS[0]).toBe(0);
    });

    it("climbs", () => {
        const climbing = [...CHAT_SLOWMODE_STEPS].sort((a, b) => a - b);
        expect([...CHAT_SLOWMODE_STEPS]).toEqual(climbing);
    });
});
