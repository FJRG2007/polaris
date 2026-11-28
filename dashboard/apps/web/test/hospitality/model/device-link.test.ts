/**
 * Linking a device: codes nobody misreads, and what each poll is answered.
 */

import { describe, expect, it } from "vitest";
import {
    LINK_TTL_MS,
    POLL_INTERVAL_MS,
    USER_CODE_ALPHABET,
    USER_CODE_LENGTH,
    displayUserCode,
    normalizeUserCode,
    pollAnswer,
    userCodeFrom
} from "@polaris-app/hospitality/src/model/device-link";

describe("user codes", () => {
    it("makes a code of the alphabet only, skipping biased bytes", () => {
        const code = userCodeFrom(new Uint8Array([255, 254, 0, 1, 2, 3, 4, 5, 6, 7, 30]));
        expect(code).toBe("ABCDEFGH");
        expect(code).toHaveLength(USER_CODE_LENGTH);
        expect([...code!].every((c) => USER_CODE_ALPHABET.includes(c))).toBe(true);
    });

    it("answers null rather than a short code when the bytes run out", () => {
        expect(userCodeFrom(new Uint8Array([1, 2, 3]))).toBeNull();
    });

    it("reads what somebody typed, and refuses what cannot be a code", () => {
        expect(normalizeUserCode(" abcd-efgh ")).toBe("ABCDEFGH");
        expect(normalizeUserCode("ABCD-EFG0")).toBeNull();
        expect(normalizeUserCode("ABC")).toBeNull();
        expect(displayUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
    });
});

describe("pollAnswer", () => {
    const now = new Date("2026-11-28T12:00:00Z");
    const fresh = { expiresAt: new Date(now.getTime() + LINK_TTL_MS), approvedAt: null, deviceId: null, lastPolledAt: null };

    it("waits, then slows a device that polls too fast", () => {
        expect(pollAnswer(fresh, now)).toBe("pending");
        expect(pollAnswer({ ...fresh, lastPolledAt: new Date(now.getTime() - POLL_INTERVAL_MS / 2) }, now)).toBe("slowDown");
    });

    it("hands over once: approved, then used; and an old code is expired", () => {
        expect(pollAnswer({ ...fresh, approvedAt: now }, now)).toBe("approved");
        expect(pollAnswer({ ...fresh, approvedAt: now, deviceId: "d" }, now)).toBe("used");
        expect(pollAnswer({ ...fresh, approvedAt: now, expiresAt: now }, now)).toBe("expired");
    });
});
