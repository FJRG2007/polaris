/**
 * The three things an account can do to itself.
 *
 * What is worth pinning down is not that they work - it is the four places they
 * are allowed to be surprising, and each of them is a decision somebody could
 * reasonably reverse by accident later.
 *
 * A lockdown does not end the sessions already open. That looks like a hole and
 * is the opposite: an owner locked out of the screen they need is an owner who
 * cannot lift it, and the whole design is that they keep the account while
 * somebody looks.
 *
 * Signing in restores an account its owner switched off, and never lifts a
 * suspension the instance imposed. An account holding both comes back to being
 * suspended.
 *
 * Switching off and deleting both end every session, including the one asking.
 *
 * And the wait is counted in whole days from the moment it was asked for, so a
 * banner and a sweep read the same number.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { daysLeft, DELETION_GRACE_DAYS } from "@polaris/core";

interface UserRow {
    disabledAt: Date | null;
    deletionRequestedAt: Date | null;
    bannedAt?: Date | null;
}

let user: UserRow;
let security: { lockdownAt: Date | null; lockdownNote: string | null } | null;
const sessionsDeleted = vi.fn(async () => ({ count: 3 }));
const caseOpened = vi.fn(async () => undefined);
const grantsRevoked = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async () => user,
            update: async (args: { data: Partial<UserRow> }) => {
                user = { ...user, ...args.data };
                return user;
            }
        },
        userSecurity: {
            findUnique: async () => security,
            upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
                security = { ...(security ?? { lockdownAt: null, lockdownNote: null }), ...args.update } as typeof security;
                void args.create;
                return security;
            },
            updateMany: async (args: { data: Record<string, unknown> }) => {
                security = { ...(security ?? { lockdownAt: null, lockdownNote: null }), ...args.data } as typeof security;
                return { count: 1 };
            }
        },
        session: { deleteMany: sessionsDeleted }
    }
}));

vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/safety-queue", () => ({ openLockdownCase: caseOpened }));
vi.mock("@/lib/step-up-grant", () => ({ revokeStepUpGrants: grantsRevoked }));

const lifecycle = await import("@/lib/account-lifecycle");

beforeEach(() => {
    user = { disabledAt: null, deletionRequestedAt: null };
    security = { lockdownAt: null, lockdownNote: null };
    sessionsDeleted.mockClear();
    caseOpened.mockClear();
    grantsRevoked.mockClear();
});

describe("locking down", () => {
    it("leaves the sessions already open alone", async () => {
        // The one thing about it that looks wrong and is not: the owner has to be
        // able to reach the screen that lifts it.
        await lifecycle.raiseLockdown("ada", "somebody is in my account");
        expect(sessionsDeleted).not.toHaveBeenCalled();
        expect(await lifecycle.lockedDown("ada")).toBe(true);
    });

    it("puts it in front of an administrator", async () => {
        await lifecycle.raiseLockdown("ada", "somebody is in my account");
        expect(caseOpened).toHaveBeenCalledWith("ada", "somebody is in my account");
    });

    it("drops the proofs the session was holding", async () => {
        // A proof given a minute ago was a proof about a situation that has just
        // changed.
        await lifecycle.raiseLockdown("ada", "");
        expect(grantsRevoked).toHaveBeenCalledWith("ada");
    });

    it("lifts cleanly", async () => {
        await lifecycle.raiseLockdown("ada", "");
        await lifecycle.liftLockdown("ada");
        expect(await lifecycle.lockedDown("ada")).toBe(false);
    });
});

describe("switching off and deleting", () => {
    it("ends every session, the one asking included", async () => {
        await lifecycle.closeAccount("ada", "disabled");
        expect(sessionsDeleted).toHaveBeenCalledWith({ where: { userId: "ada" } });
    });

    it("marks a deletion as switched off as well, so it disappears straight away", async () => {
        await lifecycle.closeAccount("ada", "deleting");
        expect(user.deletionRequestedAt).not.toBeNull();
        expect(user.disabledAt).not.toBeNull();
    });
});

describe("coming back", () => {
    it("is done by signing in and nothing else", async () => {
        await lifecycle.closeAccount("ada", "disabled");
        expect(await lifecycle.restoreAccount("ada")).toBe("disabled");
        expect(user.disabledAt).toBeNull();
    });

    it("calls off a deletion that had not run yet", async () => {
        await lifecycle.closeAccount("ada", "deleting");
        expect(await lifecycle.restoreAccount("ada")).toBe("deleting");
        expect(user.deletionRequestedAt).toBeNull();
        expect(user.disabledAt).toBeNull();
    });

    it("never lifts a suspension the instance imposed", async () => {
        // The reason these are two columns rather than a reason on one.
        user = { disabledAt: new Date(), deletionRequestedAt: null, bannedAt: new Date() };
        await lifecycle.restoreAccount("ada");
        expect(user.disabledAt).toBeNull();
        expect(user.bannedAt).not.toBeNull();
    });

    it("says nothing happened when nothing had", async () => {
        expect(await lifecycle.restoreAccount("ada")).toBeNull();
    });
});

describe("the wait", () => {
    it("counts whole days from when it was asked for", () => {
        const asked = new Date("2026-01-01T00:00:00Z");
        expect(daysLeft(asked, asked)).toBe(DELETION_GRACE_DAYS);
        expect(daysLeft(asked, new Date("2026-01-11T00:00:00Z"))).toBe(DELETION_GRACE_DAYS - 10);
    });

    it("floors at zero rather than going negative", () => {
        const asked = new Date("2026-01-01T00:00:00Z");
        expect(daysLeft(asked, new Date("2027-01-01T00:00:00Z"))).toBe(0);
    });
});
