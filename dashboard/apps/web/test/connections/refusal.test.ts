/**
 * What a provider said when it refused, which used to be thrown away.
 *
 * Every token exchange threw a status code and nothing else, so an Epic client
 * whose policy forbids the grant, one never linked to its application, and a
 * secret belonging to a different client all arrived at the operator as "the
 * service did not complete the authorization". The reason is the only part of
 * that sentence anybody can act on.
 */

import { describe, expect, it } from "vitest";
import { refusalMessage, refusalReason } from "@/lib/connections/refusal";

function refused(body: unknown, status = 401): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("refusalReason", () => {
    it("reads the OAuth error object providers answer with", async () => {
        const said = await refusalReason(refused({ error: "invalid_client", error_description: "Unauthorized" }));
        expect(said).toBe("Unauthorized - invalid_client");
    });

    it("reads Epic's own spelling of the same thing", async () => {
        const said = await refusalReason(
            refused({ errorCode: "errors.com.epicgames.common.oauth.unauthorized_client", errorMessage: "Client is not authorized" })
        );
        expect(said).toContain("Client is not authorized");
        expect(said).toContain("unauthorized_client");
    });

    it("says nothing rather than repeating an error page", async () => {
        expect(await refusalReason(refused("<html><body>502 Bad Gateway</body></html>"))).toBe("");
        expect(await refusalReason(refused(""))).toBe("");
    });

    it("does not repeat the same sentence under two names", async () => {
        expect(await refusalReason(refused({ error: "invalid_grant", errorCode: "invalid_grant" }))).toBe("invalid_grant");
    });

    it("keeps a runaway body down to one line", async () => {
        const said = await refusalReason(refused({ error_description: `${"x".repeat(4000)}\nand more` }));
        expect(said.length).toBeLessThanOrEqual(200);
        expect(said).not.toContain("\n");
    });
});

describe("refusalMessage", () => {
    it("names what was asked, the status, and the reason", async () => {
        const message = await refusalMessage(
            refused({ error: "invalid_client" }, 401),
            "Epic refused the token request"
        );
        expect(message).toBe("Epic refused the token request (401): invalid_client");
    });

    it("still names the status when the provider gave no reason", async () => {
        const message = await refusalMessage(refused("", 500), "Epic refused the token request");
        expect(message).toBe("Epic refused the token request (500)");
    });
});
