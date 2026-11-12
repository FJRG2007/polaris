/**
 * Refreshing a vault session.
 *
 * A refresh token lives for a month and each exchange hands back the wrapped
 * key material, so what matters here is that it dies when the sign-in that
 * produced it would now be refused: a banned account, or a role that no longer
 * carries `vault.use`. Checking only the token's own properties would leave a
 * revoked person with a month of working credentials.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "018f2b7a-0000-7000-8000-0000000000b1";

const findToken = vi.fn();
const updateToken = vi.fn(async () => ({ id: "refresh-1" }));
const createToken = vi.fn(async () => ({ id: "refresh-2" }));
const findAccount = vi.fn(async () => ({
    kdf: 0,
    kdfIterations: 600000,
    kdfMemory: null,
    kdfParallelism: null,
    protectedKey: "2.a|b|c",
    privateKey: "2.d|e|f",
    securityStamp: "stamp-1",
    user: { name: "Someone", email: "someone@polaris.test", emailVerified: true }
}));
const hasPermission = vi.fn(async () => true);
const lockConnection = vi.fn(async () => ({ count: 1 }));
const findDevice = vi.fn(async () => ({ extensionSessionId: null as string | null }));
const updateDevice = vi.fn(async () => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: async (run: (tx: unknown) => unknown) => {
            const { prisma } = await import("@polaris/db");
            return run(prisma);
        },
        vaultAccount: { findFirst: vi.fn(), findUniqueOrThrow: findAccount },
        vaultOrgUser: { findMany: vi.fn(async () => []) },
        extensionSession: { updateMany: lockConnection },
        vaultDevice: { findFirst: findDevice, upsert: vi.fn(), updateMany: updateDevice },
        vaultRefreshToken: { findUnique: findToken, update: updateToken, create: createToken }
    }
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "secret", POLARIS_APP_URL: "https://polaris.test" })
}));
vi.mock("@polaris/auth", () => ({
    userHasPermission: hasPermission,
    verifyTotpForUser: vi.fn(async () => true)
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/vault/password", () => ({ verifyVaultPassword: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: vi.fn(async () => ({ ok: true })),
    resetRateLimit: vi.fn(async () => undefined)
}));

const identity = await import("../../src/lib/vault/identity");

/** A live token row, with whatever the case under test wants changed. */
function tokenRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "refresh-1",
        userId: USER,
        deviceId: "device-1",
        stamp: "stamp-1",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        device: { identifier: "device-a", userId: USER, extension: null },
        vault: { securityStamp: "stamp-1", user: { bannedAt: null } },
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    hasPermission.mockResolvedValue(true);
    findDevice.mockResolvedValue({ extensionSessionId: null });
    lockConnection.mockResolvedValue({ count: 1 });
    findToken.mockResolvedValue(tokenRow());
});

describe("vaultRefresh", () => {
    it("refuses a device whose extension was disconnected without relying on the sweep", async () => {
        findToken.mockResolvedValue(
            tokenRow({
                device: {
                    identifier: "device-a",
                    userId: USER,
                    extension: { userId: USER, revokedAt: new Date() }
                }
            })
        );
        expect(await identity.vaultRefresh("token")).toEqual({ ok: false, kind: "invalid" });
        expect(createToken).not.toHaveBeenCalled();
    });

    it("refuses issuance when disconnect wins after the refresh read", async () => {
        findDevice.mockResolvedValue({ extensionSessionId: "connection-1" });
        lockConnection.mockResolvedValue({ count: 0 });
        expect(await identity.vaultRefresh("token")).toEqual({ ok: false, kind: "invalid" });
        expect(createToken).not.toHaveBeenCalled();
    });

    it("checks the connection again when an approved claim mints credentials", async () => {
        findDevice.mockResolvedValue({ extensionSessionId: "connection-1" });
        lockConnection.mockResolvedValue({ count: 0 });
        const { prisma } = await import("@polaris/db");
        vi.mocked(prisma.vaultDevice.upsert).mockResolvedValueOnce({ id: "device-1" } as never);
        expect(
            await identity.issueVaultToken(
                USER,
                { identifier: "device-a", name: "test", type: 2 },
                "connection-1"
            )
        ).toBeNull();
        expect(createToken).not.toHaveBeenCalled();
        expect(lockConnection).toHaveBeenCalledWith({
            where: { id: "connection-1", userId: USER, revokedAt: null },
            data: { revokedAt: null }
        });
    });

    it("issues credentials while the owning extension connection is live", async () => {
        findDevice.mockResolvedValue({ extensionSessionId: "connection-1" });
        expect((await identity.vaultRefresh("token")).ok).toBe(true);
        expect(createToken).toHaveBeenCalledOnce();
        expect(lockConnection).toHaveBeenCalledOnce();
    });

    it("preserves refresh for a client without a device", async () => {
        findToken.mockResolvedValue(tokenRow({ deviceId: null, device: null }));
        expect((await identity.vaultRefresh("token")).ok).toBe(true);
    });

    it("rotates a live token", async () => {
        const result = await identity.vaultRefresh("token");
        expect(result.ok).toBe(true);
        expect(updateToken).toHaveBeenCalled();
    });

    it("renames the token's own device when the client restates its name", async () => {
        const result = await identity.vaultRefresh("token", "Brave on Windows");
        expect(result.ok).toBe(true);
        expect(updateDevice).toHaveBeenCalledWith({
            where: { id: "device-1", NOT: { name: "Brave on Windows" } },
            data: { name: "Brave on Windows" }
        });
    });

    it("still rotates the token when the relabel fails", async () => {
        updateDevice.mockRejectedValueOnce(new Error("gone"));
        vi.spyOn(console, "error").mockImplementation(() => {});
        const result = await identity.vaultRefresh("token", "Brave on Windows");
        expect(result.ok).toBe(true);
        expect(updateToken).toHaveBeenCalled();
    });

    it("leaves the device alone when no name is given", async () => {
        await identity.vaultRefresh("token");
        expect(updateDevice).not.toHaveBeenCalled();
    });

    it("renames nothing on a refused refresh", async () => {
        findToken.mockResolvedValue(tokenRow({ revokedAt: new Date() }));
        const result = await identity.vaultRefresh("token", "Brave on Windows");
        expect(result.ok).toBe(false);
        expect(updateDevice).not.toHaveBeenCalled();
    });

    it("refuses a banned account and mints nothing", async () => {
        findToken.mockResolvedValue(
            tokenRow({ vault: { securityStamp: "stamp-1", user: { bannedAt: new Date() } } })
        );
        const result = await identity.vaultRefresh("token");
        expect(result).toEqual({ ok: false, kind: "invalid" });
        expect(updateToken).not.toHaveBeenCalled();
        expect(createToken).not.toHaveBeenCalled();
    });

    it("refuses an account whose role lost the vault, and mints nothing", async () => {
        hasPermission.mockResolvedValue(false);
        const result = await identity.vaultRefresh("token");
        expect(result).toEqual({ ok: false, kind: "invalid" });
        expect(updateToken).not.toHaveBeenCalled();
        expect(createToken).not.toHaveBeenCalled();
    });

    it("still refuses a token whose stamp has moved on", async () => {
        findToken.mockResolvedValue(
            tokenRow({ vault: { securityStamp: "stamp-2", user: { bannedAt: null } } })
        );
        expect(await identity.vaultRefresh("token")).toEqual({ ok: false, kind: "invalid" });
    });
});
