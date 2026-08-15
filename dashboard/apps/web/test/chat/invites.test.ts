/**
 * Invitations into a space.
 *
 * The code is the whole credential, so the tests are all about the moment one is
 * presented rather than the moment it was made. Every bound has to be checked
 * then, because a link that can be forwarded is a link that will be - and the
 * expiry cases in particular would pass a naive implementation that only looked
 * at the bounds when writing the row.
 */

import { describe, expect, it } from "vitest";
import {
    CHAT_INVITE_CODE_LENGTH,
    INVITE_DURATIONS,
    INVITE_FOREVER,
    INVITE_UNLIMITED,
    INVITE_USE_LIMITS,
    chatInviteCreateSchema,
    inviteCodeSchema,
    inviteExpiresAt,
    inviteUsable
} from "@polaris/core";

const now = new Date("2026-08-15T12:00:00.000Z");
const spaceId = "0193b0f0-0000-7000-8000-000000000001";

/** A usable invitation with no bounds, to vary one thing at a time from. */
const open = { expiresAt: null, maxUses: null, uses: 0, revokedAt: null };

describe("making one", () => {
    it("takes any offered length and any offered limit", () => {
        for (const expiresMinutes of [...INVITE_DURATIONS, INVITE_FOREVER]) {
            for (const maxUses of [...INVITE_USE_LIMITS, INVITE_UNLIMITED]) {
                expect(
                    chatInviteCreateSchema.safeParse({ spaceId, expiresMinutes, maxUses }).success
                ).toBe(true);
            }
        }
    });

    it("refuses a length or a limit nobody was offered", () => {
        // "Expires in 527 minutes" is not a thing the screen could describe
        // afterwards, so it is not a thing to store.
        expect(
            chatInviteCreateSchema.safeParse({ spaceId, expiresMinutes: 527, maxUses: 5 }).success
        ).toBe(false);
        expect(
            chatInviteCreateSchema.safeParse({ spaceId, expiresMinutes: 60, maxUses: 3 }).success
        ).toBe(false);
    });

    it("works out when it runs out", () => {
        expect(inviteExpiresAt(60, now)?.toISOString()).toBe("2026-08-15T13:00:00.000Z");
        expect(inviteExpiresAt(INVITE_FOREVER, now)).toBeNull();
    });
});

describe("presenting one", () => {
    it("works while it is inside every bound", () => {
        expect(inviteUsable(open, now)).toBe(true);
        expect(
            inviteUsable({ ...open, expiresAt: "2026-08-15T13:00:00.000Z", maxUses: 5, uses: 2 }, now)
        ).toBe(true);
    });

    it("stops at its end, on the moment rather than after it", () => {
        expect(inviteUsable({ ...open, expiresAt: "2026-08-15T11:59:59.000Z" }, now)).toBe(false);
        expect(inviteUsable({ ...open, expiresAt: "2026-08-15T12:00:00.000Z" }, now)).toBe(false);
    });

    it("stops when its uses are spent", () => {
        expect(inviteUsable({ ...open, maxUses: 5, uses: 5 }, now)).toBe(false);
        expect(inviteUsable({ ...open, maxUses: 1, uses: 1 }, now)).toBe(false);
        expect(inviteUsable({ ...open, maxUses: 1, uses: 0 }, now)).toBe(true);
    });

    it("stops the moment it is withdrawn, whatever its other bounds say", () => {
        expect(inviteUsable({ ...open, revokedAt: "2026-08-15T11:00:00.000Z" }, now)).toBe(false);
    });
});

describe("the code in the URL", () => {
    it("is long enough not to be guessed and short enough to read out", () => {
        expect(CHAT_INVITE_CODE_LENGTH).toBeGreaterThanOrEqual(8);
        expect(CHAT_INVITE_CODE_LENGTH).toBeLessThanOrEqual(16);
    });

    it("takes only the alphabet the generator uses", () => {
        expect(inviteCodeSchema.safeParse("aB3-_xYz90").success).toBe(true);
        // Refused before it reaches the database, so a malformed one is a
        // refusal rather than a query.
        expect(inviteCodeSchema.safeParse("../../etc/passwd").success).toBe(false);
        expect(inviteCodeSchema.safeParse("short").success).toBe(false);
        expect(inviteCodeSchema.safeParse("has spaces").success).toBe(false);
        expect(inviteCodeSchema.safeParse("a".repeat(64)).success).toBe(false);
    });
});
