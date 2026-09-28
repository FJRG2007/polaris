/**
 * The cookie a solved password leaves behind, on every Drive surface that sets
 * one: an access lock, a share link, a file drop point and a text drop point.
 *
 * Each of these once signed the link id and nothing else, so the value was the
 * same for every visitor, honoured for as long as anybody kept it, and still
 * honoured after the owner changed the password to shut somebody out. These pin
 * what the value is bound to now - the password it was solved against, a
 * server-side expiry, and for a lock the user who solved it - through the same
 * functions the pages and actions call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashLinkPassword } from "@polaris/core/link-password";

// The lock table, answered per test. Nothing else here reads the database.
const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { accessLock: { findUnique } } }));

// Imported by the services for things these tests never reach.
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: vi.fn(async () => true) }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: vi.fn(async () => "https://example.test") }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: vi.fn() }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: vi.fn() }));

const locks = await import("@/lib/access-lock-service");
const shares = await import("@/lib/share-service");
const drops = await import("@/lib/file-request-service");
const textDrops = await import("@/lib/text-request-service");
const { UNLOCK_TTL_SECONDS } = await import("@/lib/link-guards");

const SECRET = "test-secret";
const ID = "0198f0a0-0000-7000-8000-000000000001";
const OTHER_ID = "0198f0a0-0000-7000-8000-000000000002";
const USER = "user-one";

let original: string;
let changed: string;

beforeEach(async () => {
    findUnique.mockReset();
    // Real hashes, salted like the ones in the database: the same password set
    // again is a different hash, and that is a change of password too.
    original = await hashLinkPassword("first password");
    changed = await hashLinkPassword("first password");
});

/** Push `Date.now()` past the unlock's lifetime for one assertion. */
function afterExpiry<T>(check: () => T): T {
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + UNLOCK_TTL_SECONDS * 1000 + 1);
    try {
        return check();
    } finally {
        spy.mockRestore();
    }
}

/** Swap the final character of a value for another the alphabet allows. */
function tamper(value: string): string {
    return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}

describe("an access lock's unlock", () => {
    it("is signed against the hash the password was checked against", async () => {
        findUnique.mockResolvedValue({ passwordHash: original });
        expect(await locks.verifyLockPassword(ID, "first password")).toBe(original);
        expect(await locks.verifyLockPassword(ID, "wrong password")).toBeNull();
        findUnique.mockResolvedValue(null);
        expect(await locks.verifyLockPassword(ID, "first password")).toBeNull();
    });

    it("opens the lock for the user who solved it", () => {
        const value = locks.signLockUnlock({ id: ID, passwordHash: original }, USER, SECRET);
        expect(locks.verifyLockUnlock({ id: ID, passwordHash: original }, USER, value, SECRET)).toBe(true);
    });

    it("is refused once tampered with", () => {
        const value = locks.signLockUnlock({ id: ID, passwordHash: original }, USER, SECRET);
        const lock = { id: ID, passwordHash: original };
        expect(locks.verifyLockUnlock(lock, USER, tamper(value), SECRET)).toBe(false);
    });

    it("is refused once expired", () => {
        const lock = { id: ID, passwordHash: original };
        const value = locks.signLockUnlock(lock, USER, SECRET);
        expect(afterExpiry(() => locks.verifyLockUnlock(lock, USER, value, SECRET))).toBe(false);
    });

    it("is refused once the lock's password changes", () => {
        const value = locks.signLockUnlock({ id: ID, passwordHash: original }, USER, SECRET);
        expect(locks.verifyLockUnlock({ id: ID, passwordHash: changed }, USER, value, SECRET)).toBe(false);
    });

    it("does not open another lock", () => {
        const value = locks.signLockUnlock({ id: ID, passwordHash: original }, USER, SECRET);
        expect(locks.verifyLockUnlock({ id: OTHER_ID, passwordHash: original }, USER, value, SECRET)).toBe(false);
    });

    it("does not open the lock for somebody it was copied to", () => {
        const value = locks.signLockUnlock({ id: ID, passwordHash: original }, USER, SECRET);
        const lock = { id: ID, passwordHash: original };
        expect(locks.verifyLockUnlock(lock, "user-two", value, SECRET)).toBe(false);
    });

    it("keeps the cookie name it always had", () => {
        expect(locks.lockUnlockCookie(ID)).toBe(`polaris_lock_${ID}`);
    });
});

// Share links and drop points are opened by people with no account, so their
// unlock belongs to the browser rather than to a user.
const anonymous = [
    {
        name: "a share link",
        cookie: shares.shareUnlockCookie,
        cookieName: `polaris_share_${ID}`,
        sign: shares.signShareUnlock,
        verify: shares.verifyShareUnlock
    },
    {
        name: "a file drop point",
        cookie: drops.fileRequestUnlockCookie,
        cookieName: `polaris_drop_${ID}`,
        sign: drops.signFileRequestUnlock,
        verify: drops.verifyFileRequestUnlock
    },
    {
        name: "a text drop point",
        cookie: textDrops.textRequestUnlockCookie,
        cookieName: textDrops.textRequestUnlockCookie(ID),
        sign: textDrops.signTextRequestUnlock,
        verify: textDrops.verifyTextRequestUnlock
    }
];

describe.each(anonymous)("$name's unlock", ({ cookie, cookieName, sign, verify }) => {
    it("opens the link it was solved for", () => {
        expect(verify(ID, sign(ID, original, SECRET), original, SECRET)).toBe(true);
    });

    it("is refused once tampered with", () => {
        expect(verify(ID, tamper(sign(ID, original, SECRET)), original, SECRET)).toBe(false);
    });

    it("is refused once expired", () => {
        const value = sign(ID, original, SECRET);
        expect(afterExpiry(() => verify(ID, value, original, SECRET))).toBe(false);
    });

    it("is refused once the password changes", () => {
        expect(verify(ID, sign(ID, original, SECRET), changed, SECRET)).toBe(false);
    });

    it("does not open another link", () => {
        expect(verify(OTHER_ID, sign(ID, original, SECRET), original, SECRET)).toBe(false);
    });

    it("keeps the cookie name it always had", () => {
        expect(cookie(ID)).toBe(cookieName);
    });
});

describe("unlocks of different kinds", () => {
    it("never stand in for one another", () => {
        const share = shares.signShareUnlock(ID, original, SECRET);
        expect(drops.verifyFileRequestUnlock(ID, share, original, SECRET)).toBe(false);
        expect(textDrops.verifyTextRequestUnlock(ID, share, original, SECRET)).toBe(false);
        expect(locks.verifyLockUnlock({ id: ID, passwordHash: original }, USER, share, SECRET)).toBe(false);
    });
});
