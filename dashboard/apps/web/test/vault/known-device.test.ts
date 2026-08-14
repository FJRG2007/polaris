/**
 * `GET api/devices/knowndevice`, the request a client makes before it has a
 * token at all.
 *
 * This is the endpoint real Bitwarden clients 404'd on: it has to answer with
 * a bare `true`/`false`, not an error, for both spellings clients use (the
 * header pair newer clients send, and the path segments older ones send), and
 * it must never leak whether an address has an account through anything but
 * that boolean.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// accounts.ts pulls in the rate limiter, which pulls in the auth stack, which
// refuses to load without an environment. These are throwaway values.
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "test-auth-secret-test-auth-secret-32";
process.env.POLARIS_MASTER_KEY ??= "test-master-key-test-master-key-32ab";

const USER_EMAIL = "ana@example.com";
const IDENTIFIER = "device-123";

const findFirst = vi.fn(async () => null as { id: string } | null);
const rateLimit = vi.fn(async () => ({ ok: true }));

vi.mock("@polaris/db", () => ({ prisma: { vaultDevice: { findFirst } } }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "127.0.0.1",
    hashForLog: (value: string | undefined) => value
}));
vi.mock("@/lib/vault/auth", () => ({
    vaultError: (message: string, status: number) =>
        Response.json({ message, object: "error" }, { status })
}));

const accounts = await import("../../src/lib/vault/api/accounts");

/** An unauthenticated request, the way `knowndevice` is always called. */
function context(options: { headers?: Record<string, string>; params?: Record<string, string> }) {
    return {
        request: new Request("https://polaris.test/vault/api/devices/knowndevice", {
            headers: options.headers ?? {}
        }),
        params: options.params ?? {},
        principal: null,
        query: new URLSearchParams()
    };
}

function encodeEmail(email: string): string {
    return Buffer.from(email, "utf8").toString("base64url");
}

beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue(null);
    rateLimit.mockResolvedValue({ ok: true });
});

describe("knownDevice", () => {
    it("answers true for a device that has signed in before, via the header pair", async () => {
        findFirst.mockResolvedValue({ id: "d1" });
        const response = await accounts.knownDevice(
            context({
                headers: {
                    "x-request-email": encodeEmail(USER_EMAIL),
                    "x-device-identifier": IDENTIFIER
                }
            })
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toBe(true);
        expect(findFirst).toHaveBeenCalledWith({
            where: { identifier: IDENTIFIER, vault: { user: { email: USER_EMAIL } } },
            select: { id: true }
        });
    });

    it("answers false for an unknown device, not a 404", async () => {
        const response = await accounts.knownDevice(
            context({
                headers: {
                    "x-request-email": encodeEmail(USER_EMAIL),
                    "x-device-identifier": IDENTIFIER
                }
            })
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toBe(false);
    });

    it("reads the older path-segment spelling the same way", async () => {
        findFirst.mockResolvedValue({ id: "d1" });
        const response = await accounts.knownDevice(
            context({ params: { email: USER_EMAIL, identifier: IDENTIFIER } })
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toBe(true);
    });

    it("answers false rather than querying when the email or identifier is missing", async () => {
        const response = await accounts.knownDevice(context({}));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toBe(false);
        expect(findFirst).not.toHaveBeenCalled();
    });

    it("rate limits repeated calls instead of answering forever", async () => {
        rateLimit.mockResolvedValue({ ok: false });
        const response = await accounts.knownDevice(
            context({
                headers: {
                    "x-request-email": encodeEmail(USER_EMAIL),
                    "x-device-identifier": IDENTIFIER
                }
            })
        );
        expect(response.status).toBe(429);
    });
});
