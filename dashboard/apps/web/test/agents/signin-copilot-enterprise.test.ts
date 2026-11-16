/**
 * GitHub Copilot on a GitHub Enterprise domain: the domain is read one way on
 * the screen and the server, the device flow and the account lookup go to it
 * and its `api.` host, and chats go to its `copilot-api.` host unless GitHub
 * named the account's own address (OpenCode's `oauthURLs`, `userURL`,
 * `copilotBaseURL`).
 */

import { describe, expect, it } from "vitest";
import { copilotDomain, copilotDomainSchema } from "@/lib/agents/login-instances";
import {
    copilotBaseUrl,
    copilotUrls,
    pollCopilotDevice,
    requestCopilotDevice
} from "@/lib/agents/signin-copilot";
import type { LoginInit, LoginRequest } from "@/lib/agents/provider-login-http";

function scripted(answers: Record<string, { status: number; json: unknown }>) {
    const calls: Array<{ url: string; init: LoginInit }> = [];
    const request: LoginRequest = async (url, init) => {
        calls.push({ url, init });
        return answers[url] ?? { status: 404, json: null };
    };
    return { request, calls };
}

const DEVICE = { verification_uri: "https://acme.ghe.com/login/device", user_code: "ABCD-1234", device_code: "d", interval: 5 };

describe("a GitHub Enterprise domain", () => {
    it("is kept as the lowercase host alone", () => {
        expect(copilotDomain("acme.ghe.com")).toBe("acme.ghe.com");
        expect(copilotDomain(" https://ACME.ghe.com/ ")).toBe("acme.ghe.com");
        expect(copilotDomain("http://github.acme.example")).toBe("github.acme.example");
        expect(copilotDomainSchema.parse("https://acme.ghe.com")).toBe("acme.ghe.com");
    });

    it("refuses anything that is not a host of its own", () => {
        for (const bad of [
            "",
            "github.com",
            "https://github.com/",
            "api.github.com",
            "acme",
            "acme.ghe.com/path",
            "acme.ghe.com:8443",
            "https://u:p@acme.ghe.com",
            "acme.ghe.com?x=1",
            "10.0.0.1",
            "ftp://acme.ghe.com"
        ]) {
            expect(copilotDomain(bad), bad).toBeNull();
        }
        expect(copilotDomainSchema.safeParse("github.com").success).toBe(false);
    });
});

describe("a Copilot login on an Enterprise domain", () => {
    it("asks the domain for a code, a token and the account", async () => {
        const urls = copilotUrls("acme.ghe.com");
        expect(urls).toEqual({
            device: "https://acme.ghe.com/login/device/code",
            token: "https://acme.ghe.com/login/oauth/access_token",
            user: "https://api.acme.ghe.com/copilot_internal/user"
        });
        const { request, calls } = scripted({
            [urls.device]: { status: 200, json: DEVICE },
            [urls.token]: { status: 200, json: { access_token: "ghu_x" } },
            [urls.user]: { status: 200, json: { chat_enabled: true } }
        });
        const device = await requestCopilotDevice(request, 0, "acme.ghe.com");
        expect(device.domain).toBe("acme.ghe.com");
        expect(await pollCopilotDevice(request, device, 1)).toEqual({
            state: "done",
            login: { token: "ghu_x", apiEndpoint: null, enterpriseUrl: "acme.ghe.com" }
        });
        expect(calls.map((call) => call.url)).toEqual([urls.device, urls.token, urls.user]);
    });

    it("chats on the domain's Copilot API unless GitHub named the account's own", () => {
        expect(copilotBaseUrl(null, "acme.ghe.com")).toBe("https://copilot-api.acme.ghe.com");
        expect(copilotBaseUrl("https://api.enterprise.githubcopilot.com", "acme.ghe.com")).toBe(
            "https://api.enterprise.githubcopilot.com"
        );
        expect(copilotBaseUrl(null, "evil.example/path")).toBe("https://api.githubcopilot.com");
        expect(copilotBaseUrl(undefined)).toBe("https://api.githubcopilot.com");
    });

    it("leaves a GitHub.com login as it was", () => {
        expect(copilotUrls(null).device).toBe("https://github.com/login/device/code");
    });
});
