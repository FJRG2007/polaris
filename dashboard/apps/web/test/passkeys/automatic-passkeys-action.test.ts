/**
 * The server half of asking for a passkey on its own: of the ids a browser says
 * it holds, only those still registered here, bound to this address, and on an
 * account that has not turned the prompt off. Answered without an identifier, so
 * it can say nothing about which addresses have accounts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const rateLimit = vi.hoisted(() => vi.fn());
vi.mock("@polaris/db", () => ({ prisma: { passkey: { findMany } } }));
vi.mock("next/headers", () => ({
    headers: async () => new Headers({ host: "polaris.example.test" })
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_APP_URL: "https://polaris.example.test" })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "198.51.100.7" }));
vi.mock("@/lib/auth-mail", () => ({ getAuthMailStatus: vi.fn() }));
vi.mock("@/lib/saml-providers", () => ({ ssoOfferedFor: vi.fn() }));
vi.mock("@polaris/auth", () => ({ emailForUsername: vi.fn(), emailLinkSignInAllowed: vi.fn() }));
vi.mock("@/lib/qr-sign-in-service", () => ({ openSignInCode: vi.fn(), redeemSignInCode: vi.fn() }));

const { automaticPasskeys } = await import("@/app/oauth/login/actions");

const ID = "aGVsbG8td2luZG93cy1oZWxsbw";

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true });
    findMany.mockResolvedValue([{ credentialID: ID, transports: "internal, hybrid" }]);
});

describe("which passkeys the sign-in screen may ask for on its own", () => {
    it("asks the database only for live accounts that kept the prompt on, on this address", async () => {
        const allowed = await automaticPasskeys([ID]);
        expect(allowed).toEqual([{ id: ID, transports: ["internal", "hybrid"] }]);
        const where = findMany.mock.calls[0]![0].where;
        expect(where.credentialID).toEqual({ in: [ID] });
        expect(where.user).toEqual({
            bannedAt: null,
            OR: [{ security: { is: null } }, { security: { is: { autoPasskey: true } } }]
        });
        expect(where.OR).toEqual([{ rpId: "polaris.example.test" }, { rpId: null }]);
    });

    it("throttles by the caller's address", async () => {
        await automaticPasskeys([ID]);
        expect(rateLimit.mock.calls[0]![0]).toBe("passkey-auto:198.51.100.7");
    });

    it("answers nothing, without a query, for input that is not a list of credential ids", async () => {
        for (const input of [null, "x", {}, [], [42], ["short"], ["has spaces in it and more"]]) {
            expect(await automaticPasskeys(input)).toEqual([]);
        }
        expect(findMany).not.toHaveBeenCalled();
    });

    it("answers nothing once the caller is throttled", async () => {
        rateLimit.mockResolvedValue({ ok: false });
        expect(await automaticPasskeys([ID])).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });

    it("asks about twenty at most, each once", async () => {
        const many = Array.from({ length: 30 }, (_, index) => `${ID}${String(index).padStart(2, "0")}`);
        await automaticPasskeys([...many, ...many]);
        expect(findMany.mock.calls[0]![0].where.credentialID.in).toHaveLength(20);
    });
});
