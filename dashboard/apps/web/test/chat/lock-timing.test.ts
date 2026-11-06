/** How long locked chats stay open after the code, and when the open chat renews. */

import { describe, expect, it } from "vitest";
import * as timing from "@/lib/chat/lock-timing";

describe("chat unlock duration", () => {
    it("lasts the minutes the reader chose", () => {
        expect(timing.proofTtlMs(1)).toBe(60_000);
        expect(timing.proofTtlMs(15)).toBe(15 * 60_000);
        expect(timing.proofTtlMs(60)).toBe(60 * 60_000);
    });

    it("keeps the old behaviour for anybody who never chose", () => {
        expect(timing.unlockMinutesOf(undefined)).toBe(timing.UNLOCK_UNTIL_CLOSED);
        expect(timing.unlockMinutesOf(7)).toBe(timing.UNLOCK_UNTIL_CLOSED);
        expect(timing.proofTtlMs(timing.UNLOCK_UNTIL_CLOSED)).toBe(12 * 60 * 60_000);
    });

    it("immediately still gives the open chat a short proof", () => {
        expect(timing.proofTtlMs(timing.UNLOCK_IMMEDIATELY)).toBe(2 * 60_000);
    });

    it("renews well before a proof runs out, within bounds", () => {
        for (const minutes of timing.CHAT_UNLOCK_CHOICES) {
            const every = timing.renewEveryMs(minutes);
            expect(every).toBeLessThan(timing.proofTtlMs(minutes));
            expect(every).toBeGreaterThanOrEqual(10_000);
            expect(every).toBeLessThanOrEqual(60_000);
        }
        expect(timing.renewEveryMs(1)).toBe(20_000);
    });

    it("renews only after the reader did something, except while on screen under immediately", () => {
        const base = { minutes: 5, lastRenew: 1_000, visible: true };
        expect(timing.shouldRenew({ ...base, lastActivity: 500 })).toBe(false);
        expect(timing.shouldRenew({ ...base, lastActivity: 1_500 })).toBe(true);
        const now = { minutes: timing.UNLOCK_IMMEDIATELY, lastActivity: 0, lastRenew: 1_000 };
        expect(timing.shouldRenew({ ...now, visible: true })).toBe(true);
        expect(timing.shouldRenew({ ...now, visible: false })).toBe(false);
    });

    it("reads a proof's expiry, and treats a past or malformed one as gone", () => {
        const now = 1_800_000_000_000;
        expect(timing.proofExpiresAt(`${now}.sig`)).toBe(now);
        expect(timing.proofLive(`${now + 1}.sig`, now)).toBe(true);
        expect(timing.proofLive(`${now}.sig`, now)).toBe(false);
        expect(timing.proofLive("nope", now)).toBe(false);
        expect(timing.proofLive(null, now)).toBe(false);
    });
});

describe("chat lock code length", () => {
    it("knows 4, 6 and 8 digits, and nothing else", () => {
        expect(timing.knownCodeLength(4)).toBe(4);
        expect(timing.knownCodeLength(6)).toBe(6);
        expect(timing.knownCodeLength(8)).toBe(8);
        expect(timing.knownCodeLength(5)).toBeNull();
        expect(timing.knownCodeLength(null)).toBeNull();
    });
});
