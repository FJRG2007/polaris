/**
 * The time a live location has left, as its full map shows it: rounded up to
 * the minute, so a share never reads as over while it is still moving.
 */

import { describe, expect, it } from "vitest";
import { liveLeft } from "@/lib/chat/live-left";

const NOW = Date.parse("2026-11-21T10:00:00Z");

describe("a live location's time left", () => {
    it("counts minutes under an hour, rounded up", () => {
        expect(liveLeft(NOW + 14 * 60_000 + 5_000, NOW)).toEqual({ hours: 0, minutes: 15 });
    });

    it("counts hours and minutes on a long share", () => {
        expect(liveLeft(NOW + 8 * 3_600_000 - 30 * 60_000, NOW)).toEqual({ hours: 7, minutes: 30 });
    });

    it("is nothing once it has run out", () => {
        expect(liveLeft(NOW - 60_000, NOW)).toEqual({ hours: 0, minutes: 0 });
    });
});
