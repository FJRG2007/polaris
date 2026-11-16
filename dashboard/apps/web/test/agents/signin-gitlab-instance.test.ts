/**
 * GitLab Duo on a self-managed GitLab: the address and application are read
 * one way on the screen and the server, every call goes to that instance with
 * that application, and a login made before an instance could be named keeps
 * renewing on gitlab.com with OpenCode's application.
 */

import { describe, expect, it } from "vitest";
import { gitlabInstanceSchema, gitlabInstanceUrl } from "@/lib/agents/login-instances";
import {
    GITLAB_CLIENT_ID,
    GITLAB_COM,
    exchangeGitlabCode,
    gitlabDirectAccess,
    gitlabInstanceOf,
    gitlabMetadata,
    refreshGitlabTokens,
    startGitlabAuthorization
} from "@/lib/agents/signin-gitlab";
import type { LoginInit, LoginRequest } from "@/lib/agents/provider-login-http";

const OWN = { url: "https://git.example.com/gitlab", clientId: "a".repeat(64) };

function answering(status: number, json: unknown) {
    const calls: Array<{ url: string; init: LoginInit }> = [];
    const request: LoginRequest = async (url, init) => {
        calls.push({ url, init });
        return { status, json };
    };
    return { request, calls };
}

describe("a GitLab address", () => {
    it("is stored in one form", () => {
        expect(gitlabInstanceUrl("git.example.com")).toBe("https://git.example.com");
        expect(gitlabInstanceUrl("  https://Git.Example.com/gitlab//  ")).toBe("https://git.example.com/gitlab");
        expect(gitlabInstanceUrl("https://git.example.com:8443/")).toBe("https://git.example.com:8443");
    });

    it("refuses what a token must not be sent to", () => {
        for (const bad of [
            "",
            "http://git.example.com",
            "ftp://git.example.com",
            "https://user:pass@git.example.com",
            "https://git.example.com/?a=1",
            "https://git.example.com/#x",
            "https://localhost",
            "not a url at all",
            `https://${"a".repeat(600)}.com`
        ]) {
            expect(gitlabInstanceUrl(bad), bad).toBeNull();
        }
    });

    it("comes with an application ID", () => {
        expect(gitlabInstanceSchema.parse({ url: "git.example.com/gitlab/", clientId: ` ${OWN.clientId} ` })).toEqual(
            OWN
        );
        expect(gitlabInstanceSchema.safeParse({ url: "git.example.com", clientId: "short" }).success).toBe(false);
        expect(gitlabInstanceSchema.safeParse({ url: "http://git.example.com", clientId: OWN.clientId }).success).toBe(
            false
        );
    });
});

describe("a login on a self-managed GitLab", () => {
    it("authorizes, exchanges and asks Duo on that instance with that application", async () => {
        const auth = startGitlabAuthorization(OWN);
        const url = new URL(auth.url);
        expect(`${url.origin}${url.pathname}`).toBe("https://git.example.com/gitlab/oauth/authorize");
        expect(url.searchParams.get("client_id")).toBe(OWN.clientId);

        const { request, calls } = answering(200, { access_token: "acc", refresh_token: "ref" });
        await exchangeGitlabCode(request, auth, "abc", 0);
        expect(calls[0].url).toBe("https://git.example.com/gitlab/oauth/token");
        expect(calls[0].init.form?.client_id).toBe(OWN.clientId);

        const duo = answering(200, { token: "gw", headers: {} });
        await gitlabDirectAccess(duo.request, "acc", OWN.url);
        expect(duo.calls[0].url).toBe("https://git.example.com/gitlab/api/v4/ai/third_party_agents/direct_access");
    });

    it("renews with the instance and application it was made with", async () => {
        const { request, calls } = answering(200, { access_token: "a2", refresh_token: "r2" });
        await refreshGitlabTokens(request, { access: "a", refresh: "r", expires: 0, metadata: gitlabMetadata(OWN) }, 0);
        expect(calls[0].url).toBe("https://git.example.com/gitlab/oauth/token");
        expect(calls[0].init.form?.client_id).toBe(OWN.clientId);
    });

    it("reads a login from before as gitlab.com with OpenCode's application", () => {
        expect(gitlabInstanceOf(undefined)).toEqual(GITLAB_COM);
        expect(gitlabInstanceOf({ instanceUrl: "https://gitlab.com" })).toEqual(GITLAB_COM);
        expect(gitlabInstanceOf({ instanceUrl: "http://evil.example.com", clientID: OWN.clientId })).toEqual(
            GITLAB_COM
        );
        expect(gitlabInstanceOf(gitlabMetadata(OWN))).toEqual(OWN);
        expect(GITLAB_COM.clientId).toBe(GITLAB_CLIENT_ID);
    });
});
