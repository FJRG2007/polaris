/**
 * The direct rung: OpenAI's device-code endpoints called from the server.
 *
 * Asserted against a stub `post`, so what goes out (endpoint, client id, body
 * encoding) and what is made of the answers (the Codex CLI's auth.json) are
 * pinned without the network. The endpoints themselves are not exercised here.
 */

import { describe, expect, it } from "vitest";
import * as direct from "@/lib/agents/signin-direct";

type Sent = { url: string; body: Parameters<direct.DirectPost>[1] };

function stub(answers: direct.DirectResponse[]): { post: direct.DirectPost; sent: Sent[] } {
    const sent: Sent[] = [];
    const post: direct.DirectPost = async (url, body) => {
        sent.push({ url, body });
        const next = answers.shift();
        if (!next) throw new Error("no more answers");
        return next;
    };
    return { post, sent };
}

/** A fixture JWT: header and signature are placeholders, only claims matter. */
function jwt(claims: Record<string, unknown>): string {
    return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
}

const DEVICE: direct.DeviceAuthorization = {
    verificationUrl: direct.OPENAI_DEVICE_VERIFICATION_URL,
    userCode: "AB12-CD345",
    deviceAuthId: "fixture-device-auth-id",
    intervalMs: 5000,
    expiresAt: 1_000_000
};

describe("asking for a device code", () => {
    it("sends the Codex client id as JSON to the usercode endpoint", async () => {
        const { post, sent } = stub([
            { status: 200, json: { device_auth_id: "fixture-id", user_code: "AB12-CD345", interval: "7" } }
        ]);
        const device = await direct.requestDeviceAuthorization(post, 1000);
        expect(sent).toEqual([
            {
                url: "https://auth.openai.com/api/accounts/deviceauth/usercode",
                body: { json: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" } }
            }
        ]);
        expect(device).toEqual({
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "AB12-CD345",
            deviceAuthId: "fixture-id",
            intervalMs: 7000,
            expiresAt: 1000 + 15 * 60 * 1000
        });
    });

    it("accepts the older usercode field and a missing interval", async () => {
        const { post } = stub([{ status: 200, json: { device_auth_id: "x", usercode: "ZZ99-YY88" } }]);
        const device = await direct.requestDeviceAuthorization(post, 0);
        expect(device.userCode).toBe("ZZ99-YY88");
        expect(device.intervalMs).toBe(5000);
    });

    it("fails, so the caller falls back, on an error or an answer it does not know", async () => {
        await expect(direct.requestDeviceAuthorization(stub([{ status: 404, json: null }]).post, 0)).rejects.toThrow(
            direct.DirectSigninError
        );
        await expect(
            direct.requestDeviceAuthorization(stub([{ status: 200, json: { something: "else" } }]).post, 0)
        ).rejects.toThrow(direct.DirectSigninError);
    });
});

describe("waiting for the approval", () => {
    it("is still waiting on 403 and 404", async () => {
        expect(await direct.pollDeviceGrant(stub([{ status: 403, json: null }]).post, DEVICE)).toBeNull();
        expect(await direct.pollDeviceGrant(stub([{ status: 404, json: null }]).post, DEVICE)).toBeNull();
    });

    it("returns the grant once approved", async () => {
        const { post, sent } = stub([
            { status: 200, json: { authorization_code: "fixture-code", code_verifier: "fixture-verifier" } }
        ]);
        expect(await direct.pollDeviceGrant(post, DEVICE)).toEqual({
            code: "fixture-code",
            codeVerifier: "fixture-verifier"
        });
        expect(sent[0]).toEqual({
            url: "https://auth.openai.com/api/accounts/deviceauth/token",
            body: { json: { device_auth_id: "fixture-device-auth-id", user_code: "AB12-CD345" } }
        });
    });

    it("fails on anything else", async () => {
        await expect(direct.pollDeviceGrant(stub([{ status: 500, json: null }]).post, DEVICE)).rejects.toThrow(
            direct.DirectSigninError
        );
    });
});

describe("exchanging the grant", () => {
    it("posts the authorization code form-encoded with the device redirect address", async () => {
        const { post, sent } = stub([
            { status: 200, json: { access_token: "a", refresh_token: "r", id_token: "i" } }
        ]);
        await direct.exchangeGrant(post, { code: "fixture-code", codeVerifier: "fixture-verifier" });
        expect(sent[0]).toEqual({
            url: "https://auth.openai.com/oauth/token",
            body: {
                form: {
                    grant_type: "authorization_code",
                    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
                    code: "fixture-code",
                    redirect_uri: "https://auth.openai.com/deviceauth/callback",
                    code_verifier: "fixture-verifier"
                }
            }
        });
    });

    it("refuses an answer missing any of the three tokens", async () => {
        await expect(
            direct.exchangeGrant(stub([{ status: 200, json: { access_token: "a", refresh_token: "r" } }]).post, {
                code: "c",
                codeVerifier: "v"
            })
        ).rejects.toThrow(direct.DirectSigninError);
    });
});

describe("the auth.json the Codex CLI reads", () => {
    const tokens: direct.OpenAITokens = {
        accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
        refreshToken: "fixture-refresh",
        idToken: jwt({ "https://api.openai.com/profile": { email: "user@example.com" } })
    };

    it("has the CLI's own shape", () => {
        const file = JSON.parse(
            Buffer.from(direct.codexAuthFile(tokens, new Date("2026-11-10T00:00:00.000Z")), "base64").toString("utf8")
        );
        expect(file).toEqual({
            OPENAI_API_KEY: null,
            tokens: {
                id_token: tokens.idToken,
                access_token: tokens.accessToken,
                refresh_token: "fixture-refresh",
                account_id: "fixture-account"
            },
            last_refresh: "2026-11-10T00:00:00.000Z"
        });
    });

    it("reads the account and the address out of the tokens", () => {
        expect(direct.tokenIdentity(tokens)).toEqual({ accountId: "fixture-account", email: "user@example.com" });
        expect(direct.tokenIdentity({ accessToken: "x", refreshToken: "y", idToken: "z" })).toEqual({
            accountId: null,
            email: null
        });
    });

    it("is offered only for the credential it was written for", () => {
        expect(direct.hasDirectSignin("CODEX_CHATGPT_AUTH")).toBe(true);
        expect(direct.hasDirectSignin("COPILOT_DEVICE_AUTH")).toBe(false);
        expect(direct.hasDirectSignin("GEMINI_GOOGLE_AUTH")).toBe(false);
        expect(direct.hasDirectSignin("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    });
});
