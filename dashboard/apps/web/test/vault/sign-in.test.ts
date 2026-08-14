/**
 * Signing a vault client in.
 *
 * This endpoint is unauthenticated, reachable from anywhere the deployment is,
 * and the only thing in front of somebody's whole password vault. So the cases
 * here are the ones that would be exploitable rather than merely broken: that
 * every refusal looks the same from outside, that a correct password with a
 * wrong second-factor code does not reset the budget for guessing codes, and
 * that both limits - per address and per account - actually stop it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "018f2b7a-0000-7000-8000-0000000000a1";

const findFirst = vi.fn();
const findUniqueOrThrow = vi.fn();
const createRefresh = vi.fn(async () => ({ id: "refresh-1" }));
const upsertDevice = vi.fn(async () => ({ id: "device-1" }));
const orgMembers = vi.fn(async () => [] as { orgId: string; type: number }[]);
const verifyPassword = vi.fn(async () => true);
const verifyTotp = vi.fn(async () => true);
const hasPermission = vi.fn(async () => true);
const rateLimit = vi.fn(async () => ({ ok: true }));
const resetRateLimit = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultAccount: { findFirst, findUniqueOrThrow },
        vaultOrgUser: { findMany: orgMembers },
        vaultDevice: { upsert: upsertDevice },
        vaultRefreshToken: { create: createRefresh }
    }
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "secret", POLARIS_APP_URL: "https://polaris.test" })
}));
vi.mock("@polaris/auth", () => ({
    userHasPermission: hasPermission,
    verifyTotpForUser: verifyTotp
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/vault/password", () => ({ verifyVaultPassword: verifyPassword }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit, resetRateLimit }));

const { vaultSignIn } = await import("../../src/lib/vault/identity");

/** An account with a vault, no second factor, not banned. */
const ACCOUNT = {
    userId: USER,
    masterPasswordHash: "stored",
    user: { bannedAt: null, twoFactorEnabled: false }
};

const INPUT = {
    email: "Ana@Example.com",
    masterPasswordHash: "presented",
    ipHash: "hash",
    device: { identifier: "device-abc", name: "Ana's laptop", type: 6 }
};

beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue(ACCOUNT);
    findUniqueOrThrow.mockResolvedValue({
        kdf: 0,
        kdfIterations: 600000,
        kdfMemory: null,
        kdfParallelism: null,
        protectedKey: "2.a|b|c",
        privateKey: "2.d|e|f",
        securityStamp: "stamp",
        user: { name: "Ana", email: "ana@example.com", emailVerified: true }
    });
    orgMembers.mockResolvedValue([]);
    verifyPassword.mockResolvedValue(true);
    verifyTotp.mockResolvedValue(true);
    hasPermission.mockResolvedValue(true);
    rateLimit.mockResolvedValue({ ok: true });
});

describe("vaultSignIn", () => {
    it("hands back a token and the wrapped keys in one answer", async () => {
        const result = await vaultSignIn(INPUT);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.body).toMatchObject({
            token_type: "Bearer",
            Key: "2.a|b|c",
            PrivateKey: "2.d|e|f",
            Kdf: 0
        });
        expect(String(result.body.access_token).split(".")).toHaveLength(3);
        expect(createRefresh).toHaveBeenCalled();
    });

    it("looks the account up by the address lowercased", async () => {
        await vaultSignIn(INPUT);
        expect(findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { user: { email: "ana@example.com" } } })
        );
    });

    it("remembers the client so its owner can recognize it later", async () => {
        await vaultSignIn(INPUT);
        expect(upsertDevice).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId_identifier: { userId: USER, identifier: "device-abc" } }
            })
        );
    });

    it("answers an unknown address exactly as it answers a wrong password", async () => {
        findFirst.mockResolvedValueOnce(null);
        const unknown = await vaultSignIn(INPUT);
        verifyPassword.mockResolvedValueOnce(false);
        const wrong = await vaultSignIn(INPUT);
        expect(unknown).toEqual({ ok: false, kind: "invalid" });
        expect(wrong).toEqual({ ok: false, kind: "invalid" });
    });

    it("refuses a banned account without checking anything else", async () => {
        findFirst.mockResolvedValueOnce({
            ...ACCOUNT,
            user: { bannedAt: new Date(), twoFactorEnabled: false }
        });
        expect(await vaultSignIn(INPUT)).toEqual({ ok: false, kind: "invalid" });
        expect(verifyPassword).not.toHaveBeenCalled();
    });

    it("refuses an account whose role no longer allows a vault", async () => {
        hasPermission.mockResolvedValueOnce(false);
        expect(await vaultSignIn(INPUT)).toEqual({ ok: false, kind: "invalid" });
        expect(createRefresh).not.toHaveBeenCalled();
    });

    it("asks for a second factor when the account has one armed", async () => {
        findFirst.mockResolvedValueOnce({
            ...ACCOUNT,
            user: { bannedAt: null, twoFactorEnabled: true }
        });
        const result = await vaultSignIn(INPUT);
        expect(result).toMatchObject({ ok: false, kind: "two_factor", providers: [0] });
    });

    it("refuses a wrong code the same way it refuses a missing one", async () => {
        findFirst.mockResolvedValue({
            ...ACCOUNT,
            user: { bannedAt: null, twoFactorEnabled: true }
        });
        verifyTotp.mockResolvedValueOnce(false);
        const result = await vaultSignIn({ ...INPUT, twoFactorToken: "000000" });
        expect(result).toMatchObject({ ok: false, kind: "two_factor" });
        expect(createRefresh).not.toHaveBeenCalled();
    });

    it("does not clear the counters for a password that was right but a code that was not", async () => {
        // Otherwise a correct password would buy an unlimited number of guesses
        // at the six digits, which is the whole of the second factor.
        findFirst.mockResolvedValue({
            ...ACCOUNT,
            user: { bannedAt: null, twoFactorEnabled: true }
        });
        verifyTotp.mockResolvedValueOnce(false);
        await vaultSignIn({ ...INPUT, twoFactorToken: "000000" });
        expect(resetRateLimit).not.toHaveBeenCalled();
    });

    it("stops when either limit is reached, and says so as itself", async () => {
        rateLimit.mockResolvedValueOnce({ ok: false });
        expect(await vaultSignIn(INPUT)).toEqual({ ok: false, kind: "rate_limited" });
        expect(findFirst).not.toHaveBeenCalled();

        // The second call is the per-account limit; the first was per address.
        rateLimit.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
        expect(await vaultSignIn(INPUT)).toEqual({ ok: false, kind: "rate_limited" });
    });

    it("caps the codes one attempt can spend even when the password is right", async () => {
        findFirst.mockResolvedValue({
            ...ACCOUNT,
            user: { bannedAt: null, twoFactorEnabled: true }
        });
        rateLimit
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false });
        expect(await vaultSignIn({ ...INPUT, twoFactorToken: "123456" })).toEqual({
            ok: false,
            kind: "rate_limited"
        });
    });

    it("clears both counters only on a sign-in that got all the way through", async () => {
        await vaultSignIn(INPUT);
        expect(resetRateLimit).toHaveBeenCalledTimes(2);
    });
});
