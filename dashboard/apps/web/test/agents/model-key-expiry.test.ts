/**
 * Which warning a key with an end date is due.
 *
 * The point of the phases is that each is announced once: a sweep that recomputed
 * "soon" every hour would say it every hour, and one that never reached
 * "expired" would leave the last word being a warning about something that has
 * already happened.
 */

import { describe, expect, it } from "vitest";
import { EXPIRY_WARNING_DAYS, expiryPhase } from "@/lib/agents/model-key-expiry";

const now = new Date("2026-08-05T12:00:00.000Z");
const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

describe("expiryPhase", () => {
    it("says nothing about a key with no end date", () => {
        expect(expiryPhase(null, now)).toBe("");
    });

    it("says nothing while the date is far off", () => {
        expect(expiryPhase(inDays(EXPIRY_WARNING_DAYS + 1), now)).toBe("");
    });

    it("warns once the date is inside the window", () => {
        expect(expiryPhase(inDays(EXPIRY_WARNING_DAYS), now)).toBe("soon");
        expect(expiryPhase(inDays(1), now)).toBe("soon");
    });

    it("counts the moment itself as expired, not as nearly", () => {
        expect(expiryPhase(now, now)).toBe("expired");
        expect(expiryPhase(inDays(-1), now)).toBe("expired");
    });
});
