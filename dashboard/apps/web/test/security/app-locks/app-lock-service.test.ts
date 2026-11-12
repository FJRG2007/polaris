/**
 * PIN locks on apps: which paths a lock keeps shut, when an unlock expires,
 * and that the guard and the actions act on the account's own locks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    security: null as { lockedApps: string[]; pinHash: string | null } | null,
    unlocks: {} as Record<string, number>,
    upserts: [] as unknown[],
    sessionWrites: [] as unknown[]
}));
const gate = vi.hoisted(() => ({ pinAccepted: true, limited: false }));

vi.mock("@polaris/db", () => ({
    prisma: {
        userSecurity: {
            findUnique: async () => db.security,
            upsert: async (args: { update: { lockedApps: string[] } }) => {
                db.upserts.push(args);
                db.security = { pinHash: db.security?.pinHash ?? null, lockedApps: args.update.lockedApps };
            }
        },
        sessionState: {
            findUnique: async () => ({ appUnlocks: db.unlocks }),
            updateMany: async (args: { data: { appUnlocks: Record<string, number> } }) => {
                db.sessionWrites.push(args);
                db.unlocks = args.data.appUnlocks;
            }
        }
    }
}));
vi.mock("@polaris/auth", () => ({ verifyQuickPin: async () => gate.pinAccepted }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => (gate.limited ? { ok: false, retryAfterMs: 120_000 } : { ok: true }),
    resetRateLimit: async () => undefined
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1", sessionId: "session-1" })
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key
}));

import * as locks from "@/lib/app-locks";
import { appLockRedirect, getAppLocks, setAppLock } from "@/lib/app-lock-service";
import { unlockAppAction } from "@/app/(app)/app-lock/actions";
import { setAppLockAction } from "@/app/(app)/app-launcher-actions";

const NOW = 1_800_000_000_000;

beforeEach(() => {
    db.security = { lockedApps: ["chat"], pinHash: "hash" };
    db.unlocks = {};
    db.upserts = [];
    db.sessionWrites = [];
    gate.pinAccepted = true;
    gate.limited = false;
});

describe("app-locks rules", () => {
    it("never offers the account or Settings", () => {
        expect(locks.lockableApp("account")).toBe(false);
        expect(locks.lockableApp("admin")).toBe(false);
        expect(locks.lockableApp("admin-people")).toBe(false);
        expect(locks.lockableApp("chat")).toBe(true);
    });

    it("finds the locked app a path belongs to", () => {
        expect(locks.lockedAppForPath("/chat/c/1", ["chat"])).toBe("chat");
        expect(locks.lockedAppForPath("/mail", ["chat"])).toBeNull();
        expect(locks.lockedAppForPath("/account/security", ["account"])).toBeNull();
        expect(locks.lockedAppForPath("/app-lock", ["chat"])).toBeNull();
    });

    it("relocks after 15 idle minutes", () => {
        expect(locks.unlockFresh({ chat: NOW - 14 * 60_000 }, "chat", NOW)).toBe(true);
        expect(locks.unlockFresh({ chat: NOW - 15 * 60_000 }, "chat", NOW)).toBe(false);
        expect(locks.unlockFresh({}, "chat", NOW)).toBe(false);
    });

    it("only returns to a same-origin path", () => {
        expect(locks.safeReturnPath("/chat/c/1", "/chat")).toBe("/chat/c/1");
        expect(locks.safeReturnPath("//evil.example", "/chat")).toBe("/chat");
        expect(locks.safeReturnPath("https://evil.example", "/chat")).toBe("/chat");
        expect(locks.safeReturnPath("/" + String.fromCharCode(92) + "evil.example", "/chat")).toBe("/chat");
    });

    it("reads a malformed unlock column as no unlock", () => {
        expect(locks.readUnlocks("nope")).toEqual({});
        expect(locks.readUnlocks({ chat: "x" })).toEqual({});
    });
});

describe("appLockRedirect", () => {
    it("sends a locked app to the lock screen", async () => {
        expect(await appLockRedirect("user-1", "session-1", "/chat/c/1", NOW)).toBe(
            "/app-lock?app=chat&next=%2Fchat%2Fc%2F1"
        );
    });

    it("lets a fresh unlock through and keeps it fresh", async () => {
        db.unlocks = { chat: NOW - 5 * 60_000 };
        expect(await appLockRedirect("user-1", "session-1", "/chat", NOW)).toBeNull();
        expect(db.unlocks.chat).toBe(NOW);
    });

    it("relocks an unlock idle past the window", async () => {
        db.unlocks = { chat: NOW - 16 * 60_000 };
        expect(await appLockRedirect("user-1", "session-1", "/chat", NOW)).not.toBeNull();
    });

    it("ignores locks while no PIN is set", async () => {
        db.security = { lockedApps: ["chat"], pinHash: null };
        expect(await appLockRedirect("user-1", "session-1", "/chat", NOW)).toBeNull();
    });

    it("leaves apps that are not locked alone", async () => {
        expect(await appLockRedirect("user-1", "session-1", "/mail", NOW)).toBeNull();
    });
});

describe("setAppLock", () => {
    it("refuses to lock without a PIN", async () => {
        db.security = { lockedApps: [], pinHash: null };
        expect(await setAppLock("user-1", "mail", true)).toBe(false);
        expect(db.upserts).toHaveLength(0);
    });

    it("refuses the account and Settings", async () => {
        expect(await setAppLock("user-1", "account", true)).toBe(false);
        expect(await setAppLock("user-1", "admin", true)).toBe(false);
    });

    it("adds and removes a lock", async () => {
        expect(await setAppLock("user-1", "mail", true)).toBe(true);
        expect((await getAppLocks("user-1")).locked).toEqual(["chat", "mail"]);
        expect(await setAppLock("user-1", "chat", false)).toBe(true);
        expect((await getAppLocks("user-1")).locked).toEqual(["mail"]);
    });
});

describe("actions", () => {
    it("setAppLockAction validates its input", async () => {
        expect(await setAppLockAction({ appId: "../x", locked: true })).toEqual({
            error: "switcher.lockFailed"
        });
        expect(await setAppLockAction({ appId: "mail", locked: true })).toEqual({});
    });

    it("unlockAppAction unlocks on the right PIN", async () => {
        expect(await unlockAppAction({ appId: "chat", pin: "1234" })).toEqual({});
        expect(typeof db.unlocks.chat).toBe("number");
    });

    it("unlockAppAction refuses a wrong PIN without unlocking", async () => {
        gate.pinAccepted = false;
        expect(await unlockAppAction({ appId: "chat", pin: "1234" })).toEqual({
            error: "lock.errors.wrongPin"
        });
        expect(db.unlocks.chat).toBeUndefined();
    });

    it("unlockAppAction stops once the attempts are spent", async () => {
        gate.limited = true;
        expect(await unlockAppAction({ appId: "chat", pin: "1234" })).toEqual({
            error: "lock.errors.tooMany"
        });
        expect(db.unlocks.chat).toBeUndefined();
    });

    it("unlockAppAction refuses a malformed PIN", async () => {
        expect(await unlockAppAction({ appId: "chat", pin: "12ab" })).toEqual({
            error: "lock.errors.wrongPin"
        });
    });
});
