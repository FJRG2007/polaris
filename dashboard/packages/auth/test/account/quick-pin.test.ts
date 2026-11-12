/**
 * The quick PIN's length is kept beside its hash so the prompts can check it on
 * the last digit: written when the PIN is set, dropped when it is cleared, and
 * learned from the first right guess for a PIN set before it was kept.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    userId: string;
    pinHash: string | null;
    pinLength: number | null;
    pinUpdatedAt: Date | null;
}

let row: Row | null = null;

const userSecurity = {
    findUnique: vi.fn(async () => row),
    upsert: vi.fn(async ({ create, update }: { create: Row; update: Partial<Row> }) => {
        row = row ? { ...row, ...update } : { pinHash: null, pinLength: null, pinUpdatedAt: null, ...create };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        const hit =
            row !== null &&
            row.userId === where.userId &&
            row.pinHash === where.pinHash &&
            row.pinLength === where.pinLength;
        if (hit) row = { ...row!, ...data };
        return { count: hit ? 1 : 0 };
    })
};

vi.mock("@polaris/db", () => ({
    prisma: {
        userSecurity,
        userAccessGroup: { findMany: async () => [] },
        account: { findFirst: async () => ({ password: "hashed:right-password" }) }
    }
}));

const auth = {
    $context: Promise.resolve({
        password: {
            hash: async (value: string) => `hashed:${value}`,
            verify: async ({ hash, password }: { hash: string; password: string }) => hash === `hashed:${password}`
        }
    })
} as unknown as import("../../src/auth.js").Auth;

const { clearQuickPin, getUserSecurity, setQuickPin, verifyQuickPin } = await import("../../src/security.js");

beforeEach(() => {
    row = null;
    vi.clearAllMocks();
});

describe("the quick PIN's length", () => {
    it.each(["1234", "12345", "123456"])("is written when %s is set", async (pin) => {
        expect(await setQuickPin(auth, "user-1", pin, "right-password")).toEqual({});
        expect(row?.pinLength).toBe(pin.length);
        expect(row?.pinHash).toBe(`hashed:${pin}`);
    });

    it("follows a change to a PIN of another length", async () => {
        await setQuickPin(auth, "user-1", "123456", "right-password");
        await setQuickPin(auth, "user-1", "4321", "right-password");
        expect(row?.pinLength).toBe(4);
    });

    it("is not written when the password is wrong", async () => {
        expect((await setQuickPin(auth, "user-1", "1234", "wrong")).error).toBeTruthy();
        expect(row).toBeNull();
    });

    it("is cleared with the PIN", async () => {
        await setQuickPin(auth, "user-1", "1234", "right-password");
        expect(await clearQuickPin(auth, "user-1", "right-password")).toEqual({});
        expect(row?.pinHash).toBeNull();
        expect(row?.pinLength).toBeNull();
    });

    it("is learned on the first right PIN when it was never kept", async () => {
        row = { userId: "user-1", pinHash: "hashed:12345", pinLength: null, pinUpdatedAt: null };
        expect(await verifyQuickPin(auth, "user-1", "12345")).toBe(true);
        expect(row.pinLength).toBe(5);
        expect(userSecurity.updateMany).toHaveBeenCalledWith({
            where: { userId: "user-1", pinHash: "hashed:12345", pinLength: null },
            data: { pinLength: 5 }
        });
    });

    it("is not learned from a wrong PIN", async () => {
        row = { userId: "user-1", pinHash: "hashed:12345", pinLength: null, pinUpdatedAt: null };
        expect(await verifyQuickPin(auth, "user-1", "1234")).toBe(false);
        expect(row.pinLength).toBeNull();
        expect(userSecurity.updateMany).not.toHaveBeenCalled();
    });

    it("is not rewritten once known", async () => {
        row = { userId: "user-1", pinHash: "hashed:1234", pinLength: 4, pinUpdatedAt: null };
        expect(await verifyQuickPin(auth, "user-1", "1234")).toBe(true);
        expect(userSecurity.updateMany).not.toHaveBeenCalled();
    });

    it("reaches the prompts only while a PIN is set", async () => {
        row = { userId: "user-1", pinHash: "hashed:1234", pinLength: 4, pinUpdatedAt: null };
        expect((await getUserSecurity("user-1")).pinLength).toBe(4);
        row = { userId: "user-1", pinHash: null, pinLength: 4, pinUpdatedAt: null };
        expect((await getUserSecurity("user-1")).pinLength).toBeNull();
    });
});
