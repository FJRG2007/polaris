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

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultAccount: { findFirst: vi.fn(), findUniqueOrThrow: findAccount },
        vaultOrgUser: { findMany: vi.fn(async () => []) },
        vaultDevice: { upsert: vi.fn() },
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
        device: { identifier: "device-a" },
        vault: { securityStamp: "stamp-1", user: { bannedAt: null } },
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    hasPermission.mockResolvedValue(true);
    findToken.mockResolvedValue(tokenRow());
});

describe("vaultRefresh", () => {
    it("rotates a live token", async () => {
        const result = await identity.vaultRefresh("token");
        expect(result.ok).toBe(true);
        expect(updateToken).toHaveBeenCalled();
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
