import { describe, expect, it } from "vitest";
import {
    GITLAB_CLIENT_ID,
    GITLAB_DIRECT_ACCESS_URL,
    GITLAB_REDIRECT_URI,
    codeFromPaste,
    duoModel,
    exchangeGitlabCode,
    gitlabDirectAccess,
    refreshGitlabTokens,
    startGitlabAuthorization
} from "@/lib/agents/signin-gitlab";
import type { LoginInit, LoginRequest } from "@/lib/agents/provider-login-http";

function answering(status: number, json: unknown) {
    const calls: Array<{ url: string; init: LoginInit }> = [];
    const request: LoginRequest = async (url, init) => {
        calls.push({ url, init });
        return { status, json };
    };
    return { request, calls };
}

describe("GitLab Duo login", () => {
    it("builds a PKCE authorization on gitlab.com with OpenCode's app", () => {
        const auth = startGitlabAuthorization();
        const url = new URL(auth.url);
        expect(url.origin + url.pathname).toBe("https://gitlab.com/oauth/authorize");
        expect(url.searchParams.get("client_id")).toBe(GITLAB_CLIENT_ID);
        expect(url.searchParams.get("redirect_uri")).toBe(GITLAB_REDIRECT_URI);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("state")).toBe(auth.state);
    });

    it("reads the code from the pasted address only when its state matches", () => {
        const auth = startGitlabAuthorization();
        expect(codeFromPaste(`${GITLAB_REDIRECT_URI}?code=abc123&state=${auth.state}`, auth.state)).toBe("abc123");
        expect(codeFromPaste(`${GITLAB_REDIRECT_URI}?code=abc123&state=other`, auth.state)).toBeNull();
        expect(codeFromPaste(`${GITLAB_REDIRECT_URI}?error=access_denied&state=${auth.state}`, auth.state)).toBeNull();
        expect(codeFromPaste("not a url", auth.state)).toBeNull();
        expect(codeFromPaste("a".repeat(64), auth.state)).toBe("a".repeat(64));
    });

    it("exchanges and refreshes form-encoded, two hours when GitLab does not say", async () => {
        const auth = startGitlabAuthorization();
        const { request, calls } = answering(200, { access_token: "acc", refresh_token: "ref" });
        expect(await exchangeGitlabCode(request, auth, "abc", 0)).toEqual({
            access: "acc",
            refresh: "ref",
            expires: 7_200_000
        });
        expect(calls[0].url).toBe("https://gitlab.com/oauth/token");
        expect(calls[0].init.form).toMatchObject({
            grant_type: "authorization_code",
            code_verifier: auth.verifier,
            client_id: GITLAB_CLIENT_ID
        });
        const renewed = answering(200, { access_token: "acc2", refresh_token: "ref2", expires_in: 60 });
        expect(await refreshGitlabTokens(renewed.request, { access: "acc", refresh: "ref", expires: 0 }, 0)).toEqual({
            access: "acc2",
            refresh: "ref2",
            expires: 60_000
        });
        expect(renewed.calls[0].init.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref" });
    });

    it("gets a gateway token and drops the key header", async () => {
        const { request, calls } = answering(200, {
            token: "gw",
            headers: { "x-api-key": "k", "x-gitlab-instance-id": "i" }
        });
        expect(await gitlabDirectAccess(request, "acc")).toEqual({
            token: "gw",
            headers: { "x-gitlab-instance-id": "i" }
        });
        expect(calls[0].url).toBe(GITLAB_DIRECT_ACCESS_URL);
        expect(calls[0].init.headers?.Authorization).toBe("Bearer acc");
        await expect(gitlabDirectAccess(answering(403, {}).request, "acc")).rejects.toThrow("not available");
    });

    it("maps Duo ids to their upstream model and API", () => {
        expect(duoModel("duo-chat-sonnet-4-5")).toEqual({ api: "anthropic", model: "claude-sonnet-4-5-20250929" });
        expect(duoModel("duo-chat-gpt-5-mini")).toEqual({ api: "openai-chat", model: "gpt-5-mini-2025-08-07" });
        expect(duoModel("duo-chat-gpt-6-sol")).toEqual({ api: "openai-responses", model: "gpt-6-sol" });
        expect(duoModel("nope")).toBeNull();
    });
});
