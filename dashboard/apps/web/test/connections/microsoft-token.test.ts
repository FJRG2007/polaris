/**
 * A Microsoft token that could not be minted, told apart by why.
 *
 * A refused grant - a 400 or 401 from the token endpoint - means the account has
 * to be linked again. Anything else - the network, DNS, a 5xx - means try again
 * later, and must never read as a refusal: that pauses a mailbox and tells its
 * owner to reconnect an authorization that still works.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/connections/oauth-app", () => ({ oauthClientFor: async () => null }));

const { microsoftAccessToken, MicrosoftAuthExpiredError } = await import("@/lib/connections/microsoft");

const CLIENT = { clientId: "client", clientSecret: "secret" };

function answer(status: number, body: unknown): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("minting a Microsoft access token", () => {
    it("reads a refused grant as a refusal", async () => {
        answer(400, { error: "invalid_grant", error_description: "AADSTS70000: The grant is expired." });
        const attempt = microsoftAccessToken(CLIENT, "refresh-400");
        await expect(attempt).rejects.toBeInstanceOf(MicrosoftAuthExpiredError);
        await expect(attempt).rejects.toThrow("invalid_grant");
    });

    it("leaves a server having a bad minute as a retry", async () => {
        answer(503, { error: "temporarily_unavailable" });
        const attempt = microsoftAccessToken(CLIENT, "refresh-503");
        await expect(attempt).rejects.toThrow("(503)");
        await expect(attempt).rejects.not.toBeInstanceOf(MicrosoftAuthExpiredError);
    });

    it("leaves a network that did not answer as a retry", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("fetch failed");
            })
        );
        await expect(microsoftAccessToken(CLIENT, "refresh-offline")).rejects.not.toBeInstanceOf(
            MicrosoftAuthExpiredError
        );
    });

    it("hands back the token when it is minted", async () => {
        answer(200, { access_token: "access", expires_in: 3600 });
        await expect(microsoftAccessToken(CLIENT, "refresh-ok")).resolves.toBe("access");
    });
});
