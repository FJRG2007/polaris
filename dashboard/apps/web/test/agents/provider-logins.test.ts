import { beforeEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Array<{ owner: string; provider: string; name: string; secret: string }>);
vi.mock("@/lib/agents/model-keys", () => ({
    ownerHasModelKeyName: vi.fn(async (_owner: string, name: string) => name === "SuperGrok"),
    createModelKey: vi.fn(async (owner: string, input: { provider: string; name: string; secret: string }) => {
        created.push({ owner, ...input });
        return { id: "key-1" };
    })
}));

import {
    finishGitlabLogin,
    pollProviderLogin,
    resetProviderLogins,
    startProviderLogin
} from "@/lib/agents/provider-logins";
import { readOAuthSecret } from "@/lib/agents/provider-oauth";
import type { LoginRequest } from "@/lib/agents/provider-login-http";

// xAI's device answer, in the shape OpenCode's xai.ts reads.
const xaiDevice = {
    device_code: "d",
    user_code: "WXYZ",
    verification_uri: "https://accounts.x.ai/device",
    interval: 5,
    expires_in: 600
};

beforeEach(() => {
    created.length = 0;
    resetProviderLogins();
});

describe("provider logins", () => {
    it("stores a finished SuperGrok login as the person's own xai key, under a free name", async () => {
        const request: LoginRequest = async (url) =>
            url.endsWith("/device/code")
                ? { status: 200, json: xaiDevice }
                : { status: 200, json: { access_token: "acc", refresh_token: "ref", expires_in: 3600 } };
        const start = await startProviderLogin("u1", "xai", request, 0);
        expect(start).toMatchObject({ userCode: "WXYZ", paste: false });
        // Before the vendor's interval: answered without asking.
        expect(await pollProviderLogin("u1", start.id, request, 1000)).toEqual({ state: "pending" });
        expect(await pollProviderLogin("u2", start.id, request, 6000)).toEqual({ state: "gone" });
        expect(await pollProviderLogin("u1", start.id, request, 6000)).toEqual({ state: "done", keyId: "key-1" });
        expect(created[0]).toMatchObject({ owner: "u1", provider: "xai", name: "SuperGrok 2" });
        expect(readOAuthSecret(created[0].secret)).toMatchObject({
            access: "acc",
            refresh: "ref",
            expires: 6000 + 3_600_000
        });
    });

    it("refuses a GitLab paste with no matching code without storing anything", async () => {
        const request: LoginRequest = async () => ({ status: 500, json: null });
        const start = await startProviderLogin("u1", "gitlab", request, 0);
        expect(start.paste).toBe(true);
        expect(
            await finishGitlabLogin("u1", start.id, "http://127.0.0.1:8080/callback?code=x&state=wrong", request)
        ).toEqual({ state: "bad-paste" });
        expect(created).toHaveLength(0);
    });
});
