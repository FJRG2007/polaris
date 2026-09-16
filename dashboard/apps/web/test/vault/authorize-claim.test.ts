/**
 * Collecting an approval, and what a browser still holds when that fails.
 *
 * Issuing the account credential clears whatever this browser was given
 * before. The approval row is spent by then, so anything that can still fail
 * after that clearing would leave a browser that was signed in before it asked
 * holding nothing - and unable to ask again without a second approval.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The handler module pulls in the service layer, which refuses to load without an
// environment. None of it runs here; these are throwaway values.
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "test-auth-secret-test-auth-secret-32";
process.env.POLARIS_MASTER_KEY ??= "test-master-key-test-master-key-32ab";

const DEVICE = { identifier: "extension-1", name: "Polaris for Chrome", type: 2 };

const claimVaultAuthorization = vi.fn(async () => ({
    status: "approved",
    claimed: { userId: "user-1", device: DEVICE, wrappedKey: "sealed" }
}));
const issueClientKey = vi.fn(async () => "pol.secret" as string | null);
const issueVaultToken = vi.fn(async () => ({ access_token: "access", refresh_token: "refresh" }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true }),
    resetRateLimit: vi.fn()
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.7",
    clientHost: async () => "polaris.example",
    clientUserAgent: async () => "Chrome",
    hashForLog: (value: string | null) => (value ? `h(${value})` : null)
}));
vi.mock("@/lib/vault/authorization", () => ({
    openVaultAuthorization: vi.fn(),
    claimVaultAuthorization
}));
vi.mock("@/lib/vault/client-key", () => ({ issueClientKey }));
vi.mock("@/lib/vault/identity", () => ({
    issueVaultToken,
    twoFactorChallengeBody: vi.fn(),
    vaultRefresh: vi.fn(),
    vaultSignIn: vi.fn()
}));

const { connectAuthorizeClaim } = await import("../../src/lib/vault/api/identity");

function claim(): Parameters<typeof connectAuthorizeClaim>[0] {
    return {
        request: new Request("https://polaris.example/identity/connect/authorize/claim", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceCode: "polling-secret" })
        })
    } as Parameters<typeof connectAuthorizeClaim>[0];
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("collecting an approval", () => {
    it("hands back the sealed key, the account credential and the token", async () => {
        const response = await connectAuthorizeClaim(claim());
        await expect(response.json()).resolves.toEqual({
            status: "approved",
            wrappedKey: "sealed",
            accountKey: "pol.secret",
            access_token: "access",
            refresh_token: "refresh"
        });
    });

    it("never clears the browser's old credential when the token could not be minted", async () => {
        issueVaultToken.mockRejectedValueOnce(new Error("the database was not there"));

        await expect(connectAuthorizeClaim(claim())).rejects.toThrow();
        expect(issueClientKey).not.toHaveBeenCalled();
    });
});
