/**
 * A changed vault key strands every passkey wrap, so the server drops them in
 * the same step and says so - but only when the key may really have changed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
    vaultAccount: { findUnique: vi.fn(), update: vi.fn() },
    vaultRefreshToken: { updateMany: vi.fn() },
    vaultPasskey: { deleteMany: vi.fn() },
    $transaction: vi.fn()
}));
const recordAudit = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob: vi.fn() }));
vi.mock("@/lib/vault/password", () => ({
    hashVaultPassword: async (value: string) => `hashed:${value}`,
    newSecurityStamp: () => "stamp",
    verifyVaultPassword: async (stored: string, given: string) => stored === given
}));

const { changeMasterPassword } = await import("@/lib/vault/account");

const OLD_KEY = "2.b2xk|aXY=|bWFj";
const NEW_KEY = "2.bmV3|aXY=|bWFj";

function change(newProtectedKey: string, sameVaultKey?: boolean) {
    return changeMasterPassword("user-1", {
        currentHash: "current",
        newHash: "next",
        newProtectedKey,
        sameVaultKey
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    prisma.vaultAccount.findUnique.mockResolvedValue({
        masterPasswordHash: "current",
        protectedKey: OLD_KEY
    });
    prisma.vaultPasskey.deleteMany.mockImplementation((args) => args);
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => [
        {},
        { count: 0 },
        { count: (ops[2] as { where: { userId?: string } }).where.userId ? 2 : 0 }
    ]);
});

function deleted() {
    return prisma.vaultPasskey.deleteMany.mock.calls[0]![0].where;
}
function audited(action: string) {
    return recordAudit.mock.calls.some(([entry]) => entry.action === action);
}

describe("vault passkeys on a key change", () => {
    it("drops them and records it when a client sends a different wrapped key", async () => {
        expect(await change(NEW_KEY)).toEqual({ ok: true });
        expect(deleted()).toEqual({ userId: "user-1" });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "vault.passkeys.reset", metadata: { removed: 2 } })
        );
    });

    it("keeps them when the Polaris screens re-wrap the same key", async () => {
        expect(await change(NEW_KEY, true)).toEqual({ ok: true });
        expect(deleted()).not.toHaveProperty("userId");
        expect(audited("vault.passkeys.reset")).toBe(false);
    });

    it("keeps them when the wrapped key is the one already stored", async () => {
        await change(OLD_KEY);
        expect(deleted()).not.toHaveProperty("userId");
        expect(audited("vault.passkeys.reset")).toBe(false);
    });

    it("touches nothing on a wrong master password", async () => {
        prisma.vaultAccount.findUnique.mockResolvedValue({
            masterPasswordHash: "other",
            protectedKey: OLD_KEY
        });
        expect(await change(NEW_KEY)).toEqual({ ok: false, reason: "wrong_password" });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
