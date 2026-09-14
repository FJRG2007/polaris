/**
 * The endpoint an extension asks on to be let in.
 *
 * It is unauthenticated by nature - nobody has said who they are yet - so what is
 * pinned here is the order the work happens in. Checking the public key means
 * importing a key a stranger chose, and a limit that came after that would bound
 * how many rows can be opened while leaving the expensive step in front of it open
 * to anyone. So a refused request must be refused before the key is looked at, not
 * after.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The handler module pulls in the service layer, which refuses to load without an
// environment. None of it runs here; these are throwaway values.
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "test-auth-secret-test-auth-secret-32";
process.env.POLARIS_MASTER_KEY ??= "test-master-key-test-master-key-32ab";

const rateLimit = vi.fn(async () => ({ ok: true }) as { ok: boolean });
const openVaultAuthorization = vi.fn(async () => ({
    userCode: "BCDFGHJK",
    deviceCode: "polling-secret",
    expiresAt: new Date("2026-09-14T10:05:00.000Z"),
    pollMs: 2000
}) as { userCode: string; deviceCode: string; expiresAt: Date; pollMs: number } | null);

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit, resetRateLimit: vi.fn() }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.7",
    clientHost: async () => "polaris.example",
    clientUserAgent: async () => "Chrome",
    hashForLog: (value: string | null) => (value ? `h(${value})` : null)
}));
vi.mock("@/lib/vault/authorization", () => ({
    openVaultAuthorization,
    claimVaultAuthorization: vi.fn()
}));

const { connectAuthorize } = await import("../../src/lib/vault/api/identity");

/** A real RSA-OAEP public half, because "is a key a vault key can be sealed to" is
 *  what the handler actually asks and no string stands in for it. */
const pair = await crypto.subtle.generateKey(
    {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-1"
    },
    true,
    ["encrypt", "decrypt"]
);
const PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString(
    "base64"
);

const DEVICE = { deviceIdentifier: "extension-1", deviceName: "Polaris for Chrome", deviceType: 2 };

function ask(body: Record<string, unknown>): Parameters<typeof connectAuthorize>[0] {
    return {
        request: new Request("https://polaris.example/identity/connect/authorize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    } as Parameters<typeof connectAuthorize>[0];
}

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true });
});

describe("opening an authorization request", () => {
    it("hands back a code to show and a secret to poll with", async () => {
        const response = await connectAuthorize(ask({ publicKey: PUBLIC_KEY, ...DEVICE }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            userCode: "BCDFGHJK",
            deviceCode: "polling-secret",
            pollMs: 2000
        });
    });

    it("counts the request before it does the work of checking the key", async () => {
        // The one that matters. The body carries a public key that is not one, so
        // an endpoint that validated first would answer with the key's refusal -
        // having already run the import. Being told 429 instead is what says the
        // limit gates the work rather than trailing it.
        rateLimit.mockResolvedValue({ ok: false });
        const response = await connectAuthorize(
            ask({ publicKey: "!!!! not base64 !!!!", ...DEVICE })
        );
        expect(response.status).toBe(429);
        expect((await response.json()).error_description).toContain("Too many requests");
        expect(openVaultAuthorization).not.toHaveBeenCalled();
    });

    it("refuses a key no vault key could be sealed to", async () => {
        const response = await connectAuthorize(
            ask({ publicKey: "!!!! not base64 !!!!", ...DEVICE })
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error_description).toContain("sealed to");
        expect(openVaultAuthorization).not.toHaveBeenCalled();
    });

    it("says so in a shape the client reads when no code was free", async () => {
        // Every draw taken. The service answers null rather than throwing, and
        // this is where that becomes something the extension can retry on.
        openVaultAuthorization.mockResolvedValue(null);
        const response = await connectAuthorize(ask({ publicKey: PUBLIC_KEY, ...DEVICE }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    });
});
