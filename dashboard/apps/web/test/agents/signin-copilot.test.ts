import { describe, expect, it } from "vitest";
import {
    COPILOT_CLIENT_ID,
    COPILOT_TOKEN_URL,
    COPILOT_USER_URL,
    copilotBaseUrl,
    pollCopilotDevice,
    requestCopilotDevice
} from "@/lib/agents/signin-copilot";
import type { LoginInit, LoginRequest } from "@/lib/agents/provider-login-http";

// Answers in the shapes OpenCode's github-copilot.ts decodes (Device, Token, User).
function scripted(answers: Record<string, { status: number; json: unknown }>) {
    const calls: Array<{ url: string; init: LoginInit }> = [];
    const request: LoginRequest = async (url, init) => {
        calls.push({ url, init });
        const answer = answers[url];
        if (!answer) throw new Error(`unexpected ${url}`);
        return answer;
    };
    return { request, calls };
}

const DEVICE_URL = "https://github.com/login/device/code";
const device = {
    verification_uri: "https://github.com/login/device",
    user_code: "ABCD-1234",
    device_code: "dev-code",
    interval: 5
};

async function started() {
    return requestCopilotDevice(scripted({ [DEVICE_URL]: { status: 200, json: device } }).request, 0);
}

describe("Copilot device login", () => {
    it("asks GitHub for a code with OpenCode's client and read:user", async () => {
        const { request, calls } = scripted({ [DEVICE_URL]: { status: 200, json: device } });
        const code = await requestCopilotDevice(request, 1000);
        expect(code).toMatchObject({
            userCode: "ABCD-1234",
            verificationUrl: device.verification_uri,
            intervalMs: 5000
        });
        expect(calls[0].init.json).toEqual({ client_id: COPILOT_CLIENT_ID, scope: "read:user" });
        expect(calls[0].init.headers?.Accept).toBe("application/json");
    });

    it("reads pending, slow_down, denied and expired answers", async () => {
        const code = await started();
        for (const [error, state] of [
            ["authorization_pending", "pending"],
            ["slow_down", "slower"],
            ["access_denied", "denied"],
            ["expired_token", "expired"]
        ]) {
            const { request } = scripted({ [COPILOT_TOKEN_URL]: { status: 200, json: { error } } });
            expect((await pollCopilotDevice(request, code, 1)).state).toBe(state);
        }
    });

    it("finishes with the token and the account's own API address", async () => {
        const code = await started();
        const { request, calls } = scripted({
            [COPILOT_TOKEN_URL]: { status: 200, json: { access_token: "gho_token" } },
            [COPILOT_USER_URL]: {
                status: 200,
                json: { chat_enabled: true, endpoints: { api: "https://api.business.githubcopilot.com/" } }
            }
        });
        expect(await pollCopilotDevice(request, code, 1)).toEqual({
            state: "done",
            login: { token: "gho_token", apiEndpoint: "https://api.business.githubcopilot.com" }
        });
        expect(calls[1].init.headers?.Authorization).toBe("Bearer gho_token");
        expect(copilotBaseUrl(null)).toBe("https://api.githubcopilot.com");
    });

    it("refuses an account without Copilot, and not over a failed lookup", async () => {
        const code = await started();
        const refused = scripted({
            [COPILOT_TOKEN_URL]: { status: 200, json: { access_token: "t" } },
            [COPILOT_USER_URL]: { status: 200, json: { chat_enabled: false, can_signup_for_limited: true } }
        });
        expect(await pollCopilotDevice(refused.request, code, 1)).toEqual({ state: "no-copilot", canSignUp: true });
        const hiccup = scripted({
            [COPILOT_TOKEN_URL]: { status: 200, json: { access_token: "t" } },
            [COPILOT_USER_URL]: { status: 502, json: null }
        });
        expect(await pollCopilotDevice(hiccup.request, code, 1)).toEqual({
            state: "done",
            login: { token: "t", apiEndpoint: null }
        });
    });

    it("treats a code past its life as expired without asking", async () => {
        const code = await started();
        const { request, calls } = scripted({});
        expect((await pollCopilotDevice(request, code, 16 * 60_000)).state).toBe("expired");
        expect(calls).toHaveLength(0);
    });
});
