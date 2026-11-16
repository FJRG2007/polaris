/**
 * The OpenCode Console sign-in, against answers in the shapes OpenCode's
 * `opencode.ts` and `usage-limits.ts` decode: device code, waiting poll, the
 * account and workspace behind a token, refresh, and the Go allowance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginInit, LoginRequest } from "@/lib/agents/provider-login-http";

const created = vi.hoisted(() => [] as Array<{ owner: string; provider: string; name: string; secret: string }>);
vi.mock("@/lib/agents/model-keys", () => ({
    ownerHasModelKeyName: vi.fn(async () => false),
    createModelKey: vi.fn(async (owner: string, input: { provider: string; name: string; secret: string }) => {
        created.push({ owner, ...input });
        return { id: "key-oc" };
    }),
    chatCredentialsFor: vi.fn(async (_user: string, provider: string) =>
        provider === "opencode-go"
            ? [
                  {
                      provider,
                      source: "own",
                      secret: "acc",
                      keyId: "k1",
                      keyName: "OpenCode Go",
                      oauth: { orgID: "org_b", orgName: "Beta" }
                  },
                  { provider, source: "own", secret: "plain-key", keyId: "k2", keyName: "Pasted" }
              ]
            : []
    )
}));

const oc = await import("@/lib/agents/signin-opencode");
const logins = await import("@/lib/agents/provider-logins");
const { readOAuthSecret } = await import("@/lib/agents/provider-oauth");
const { goUsageFor, resetGoUsageCache } = await import("@/lib/agents/go-usage");

const DEVICE = {
    device_code: "dev",
    user_code: "ABCD-EFGH",
    verification_uri_complete: "/device?code=ABCD-EFGH",
    expires_in: 600,
    interval: 5
};
const ORGS = [
    { id: "org_b", name: "Beta" },
    { id: "org_a", name: "Alpha" }
];
const GO = {
    usage: {
        rolling: { status: "ok", percent: 12.4, resetsAt: "2026-11-16T15:00:00.000Z" },
        weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-20T00:00:00.000Z" },
        monthly: { status: "ok", percent: 40, resetsAt: "2026-12-01T00:00:00.000Z" }
    }
};
const TOKEN = { access_token: "acc", refresh_token: "ref", expires_in: 3600 };

function scripted(answer: (url: string, init: LoginInit) => { status: number; json: unknown }) {
    const calls: Array<{ url: string; init: LoginInit }> = [];
    const request: LoginRequest = async (url, init) => {
        calls.push({ url, init });
        return answer(url, init);
    };
    return { request, calls };
}

/** The Console, answering the token endpoint with `token`. */
function consoleAnswering(token: { status: number; json: unknown }) {
    return scripted((url) => {
        if (url === oc.OPENCODE_DEVICE_URL) return { status: 200, json: DEVICE };
        if (url === oc.OPENCODE_TOKEN_URL) return token;
        if (url === oc.OPENCODE_USER_URL) return { status: 200, json: { id: "usr_1", email: "dev@example.test" } };
        if (url === oc.OPENCODE_ORGS_URL) return { status: 200, json: ORGS };
        if (url === oc.OPENCODE_GO_USAGE_URL) return { status: 200, json: GO };
        throw new Error(`unexpected ${url}`);
    });
}

const idle = () => consoleAnswering({ status: 200, json: {} });

beforeEach(() => {
    created.length = 0;
    logins.resetProviderLogins();
    resetGoUsageCache();
});

describe("Console device login", () => {
    it("asks with OpenCode's client and org scope, and opens the Console's address", async () => {
        const { request, calls } = idle();
        const device = await oc.requestOpencodeDevice(request, 1000);
        expect(calls[0]?.init.json).toEqual({ client_id: "opencode-cli", supports_org_scope: true });
        expect(device).toMatchObject({
            userCode: "ABCD-EFGH",
            verificationUrl: "https://opencode.ai/device?code=ABCD-EFGH",
            intervalMs: 5000,
            expiresAt: 601_000
        });
    });

    it("refuses a verification address that is not HTTPS", async () => {
        const { request } = scripted(() => ({
            status: 200,
            json: { ...DEVICE, verification_uri_complete: "ftp://opencode.ai/device" }
        }));
        await expect(oc.requestOpencodeDevice(request, 0)).rejects.toThrow();
    });

    it("reads a waiting code, a slow-down, a refusal and an expired code", async () => {
        const device = await oc.requestOpencodeDevice(idle().request, 0);
        const poll = (json: unknown) =>
            oc.pollOpencodeDevice(consoleAnswering({ status: 400, json }).request, device, 1);
        expect(await poll({ error: "authorization_pending" })).toEqual({ state: "pending" });
        expect(await poll({ error: "slow_down" })).toEqual({ state: "slower" });
        expect(await poll({ error: "access_denied" })).toEqual({ state: "denied" });
        expect(await oc.pollOpencodeDevice(idle().request, device, 700_000)).toEqual({ state: "expired" });
    });

    it("ends on the workspace the sign-in chose, else the first by name", async () => {
        const device = await oc.requestOpencodeDevice(idle().request, 0);
        const answering = (json: unknown) => consoleAnswering({ status: 200, json }).request;
        expect(await oc.pollOpencodeDevice(answering({ ...TOKEN, org_id: "org_b" }), device, 10)).toEqual({
            state: "done",
            login: {
                access: "acc",
                refresh: "ref",
                expires: 10 + 3_600_000,
                metadata: { accountID: "usr_1", email: "dev@example.test", orgID: "org_b", orgName: "Beta" }
            }
        });
        const first = await oc.pollOpencodeDevice(answering(TOKEN), device, 10);
        expect(first.state === "done" ? first.login.metadata?.orgID : null).toBe("org_a");
        await expect(oc.pollOpencodeDevice(answering({ ...TOKEN, org_id: "org_x" }), device, 10)).rejects.toThrow();
    });

    it("refreshes with the refresh token and keeps the workspace", async () => {
        const { request, calls } = consoleAnswering({
            status: 200,
            json: { access_token: "new", refresh_token: "ref2", expires_in: 60 }
        });
        const login = {
            kind: "oauth" as const,
            access: "old",
            refresh: "ref",
            expires: 1,
            metadata: { orgID: "org_b", orgName: "Beta" }
        };
        expect(await oc.refreshOpencodeTokens(request, login, 100)).toEqual({
            access: "new",
            refresh: "ref2",
            expires: 60_100,
            metadata: { orgID: "org_b", orgName: "Beta" }
        });
        expect(calls[0]?.init.json).toEqual({
            grant_type: "refresh_token",
            refresh_token: "ref",
            client_id: "opencode-cli"
        });
        const signedOut = consoleAnswering({ status: 400, json: { error: "invalid_grant" } }).request;
        await expect(oc.refreshOpencodeTokens(signedOut, login, 0)).rejects.toThrow();
    });

    it("stores a finished sign-in as the person's own key on the slug chosen", async () => {
        const { request } = consoleAnswering({ status: 200, json: { ...TOKEN, org_id: "org_b" } });
        const start = await logins.startProviderLogin("u1", "opencode-go", request, 0);
        expect(start).toMatchObject({ userCode: "ABCD-EFGH", paste: false });
        expect(await logins.pollProviderLogin("u1", start.id, request, 6000)).toEqual({
            state: "done",
            keyId: "key-oc"
        });
        expect(created[0]).toMatchObject({ owner: "u1", provider: "opencode-go", name: "OpenCode Go" });
        expect(readOAuthSecret(created[0]!.secret)?.metadata?.orgID).toBe("org_b");
    });
});

describe("Go allowance", () => {
    it("reads each meter with the workspace header, and nothing for a workspace without Go", async () => {
        const { request, calls } = idle();
        const usage = await oc.readGoUsage(request, "acc", "org_b");
        expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer acc", "x-opencode-org-id": "org_b" });
        expect(usage?.weekly).toEqual({
            percent: 100,
            limited: true,
            resetsAt: Date.parse("2026-11-20T00:00:00.000Z")
        });
        const noGo = scripted(() => ({ status: 403, json: null })).request;
        expect(await oc.readGoUsage(noGo, "acc", "org_b")).toBeNull();
        expect(await oc.readGoUsage(request, "acc", undefined)).toBeNull();
    });

    it("lists only sign-ins, and asks OpenCode once a minute per sign-in", async () => {
        const { request, calls } = idle();
        const rows = await goUsageFor("u1", request, 0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ keyId: "k1", name: "OpenCode Go", workspace: "Beta", failed: false });
        expect(rows[0]?.usage?.rolling.percent).toBe(12.4);
        await goUsageFor("u1", request, 30_000);
        expect(calls).toHaveLength(1);
        await goUsageFor("u1", request, 61_000);
        expect(calls).toHaveLength(2);
    });

    it("says it could not ask instead of failing the card", async () => {
        const rows = await goUsageFor("u1", scripted(() => ({ status: 500, json: null })).request, 0);
        expect(rows[0]).toMatchObject({ usage: null, failed: true });
    });
});
