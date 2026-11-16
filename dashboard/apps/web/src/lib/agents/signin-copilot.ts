/**
 * Signing in to GitHub Copilot from the Polaris server: GitHub's device flow,
 * ported from OpenCode's provider (`packages/core/src/plugin/provider/github-copilot.ts`).
 *
 * The GitHub token it ends with is itself the bearer on Copilot's API, and it
 * does not expire, so there is nothing to refresh. The account's own API
 * address (it moves with the plan) is read once at sign-in from
 * `copilot_internal/user`, which is also the only place that says whether the
 * account can chat at all.
 *
 * Pure apart from the `request` it is handed, so every step is asserted
 * against recorded answers.
 */

import { z } from "zod";
import { DirectSigninError } from "@/lib/agents/signin-direct";
import type { LoginRequest } from "@/lib/agents/provider-login-http";

// github-copilot.ts line 22: OpenCode's public OAuth app (device flow, no
// secret), reused as Polaris reuses the Codex CLI's id for the ChatGPT login.
export const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";
// github-copilot.ts lines 23-24.
export const COPILOT_API_VERSION = "2026-08-01";
const USER_API_VERSION = "2025-04-01";
// github-copilot.ts `oauthURLs`, `userURL`, `baseURL` (GitHub.com).
export const COPILOT_DEVICE_URL = "https://github.com/login/device/code";
export const COPILOT_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
export const COPILOT_BASE_URL = "https://api.githubcopilot.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** GitHub's device codes live fifteen minutes; the answer carries no lifetime
 *  OpenCode reads, so the code is given that. */
const DEVICE_LIFETIME_MS = 15 * 60_000;

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

const deviceSchema = z.object({
    verification_uri: z.string().url(),
    user_code: z.string().min(1),
    device_code: z.string().min(1),
    interval: z.number().nonnegative()
});

const tokenSchema = z.object({
    access_token: z.string().min(1).optional(),
    error: z.string().optional(),
    interval: z.number().optional()
});

const userSchema = z.object({
    chat_enabled: z.boolean().optional(),
    can_signup_for_limited: z.boolean().optional(),
    endpoints: z.object({ api: z.string().url().optional() }).optional()
});

export interface CopilotDevice {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUrl: string;
    readonly intervalMs: number;
    readonly expiresAt: number;
}

/** A finished login: the GitHub token, and the account's API address when
 *  GitHub named one. */
export interface CopilotLogin {
    readonly token: string;
    readonly apiEndpoint: string | null;
}

export type CopilotPoll =
    | { readonly state: "done"; readonly login: CopilotLogin }
    | { readonly state: "pending" | "slower" }
    | { readonly state: "denied" | "expired" }
    /** Signed in, but the account has no Copilot (`copilotEntitlementError`). */
    | { readonly state: "no-copilot"; readonly canSignUp: boolean };

function ok(status: number): boolean {
    return status >= 200 && status < 300;
}

export async function requestCopilotDevice(request: LoginRequest, now: number): Promise<CopilotDevice> {
    const response = await request(COPILOT_DEVICE_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        json: { client_id: COPILOT_CLIENT_ID, scope: "read:user" }
    });
    if (!ok(response.status)) throw new DirectSigninError(`copilot device code: HTTP ${response.status}`);
    const parsed = deviceSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("copilot device code: unexpected answer");
    return {
        deviceCode: parsed.data.device_code,
        userCode: parsed.data.user_code,
        verificationUrl: parsed.data.verification_uri,
        intervalMs: Math.max(parsed.data.interval, 1) * 1000,
        expiresAt: now + DEVICE_LIFETIME_MS
    };
}

/** One poll. GitHub answers 200 with an `error` while the code waits. */
export async function pollCopilotDevice(
    request: LoginRequest,
    device: CopilotDevice,
    now: number
): Promise<CopilotPoll> {
    if (now >= device.expiresAt) return { state: "expired" };
    const response = await request(COPILOT_TOKEN_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        json: { client_id: COPILOT_CLIENT_ID, device_code: device.deviceCode, grant_type: DEVICE_GRANT }
    });
    if (!ok(response.status)) throw new DirectSigninError(`copilot device token: HTTP ${response.status}`);
    const parsed = tokenSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("copilot device token: unexpected answer");
    const { access_token: token, error } = parsed.data;
    if (token) return copilotAccount(request, token);
    if (error === "authorization_pending") return { state: "pending" };
    if (error === "slow_down") return { state: "slower" };
    if (error === "access_denied") return { state: "denied" };
    if (error === "expired_token") return { state: "expired" };
    throw new DirectSigninError(`copilot device token: ${error ?? "unexpected answer"}`);
}

/** The account behind a fresh token. Only an explicit "no chat" refuses the
 *  login; a failed or malformed lookup must not turn a GitHub hiccup into a
 *  denial (github-copilot.ts, the comment over `orElseSucceed`). */
async function copilotAccount(request: LoginRequest, token: string): Promise<CopilotPoll> {
    const user = await request(COPILOT_USER_URL, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": USER_API_VERSION
        }
    }).catch(() => null);
    const parsed = user && ok(user.status) ? userSchema.safeParse(user.json) : null;
    const account = parsed?.success ? parsed.data : null;
    if (account?.chat_enabled === false) {
        return { state: "no-copilot", canSignUp: account.can_signup_for_limited === true };
    }
    const api = account?.endpoints?.api?.replace(/\/+$/, "") ?? null;
    return { state: "done", login: { token, apiEndpoint: api && api.startsWith("https://") ? api : null } };
}

/** Where a chat is sent: the account's own address when GitHub named one. */
export function copilotBaseUrl(apiEndpoint: string | null | undefined): string {
    return apiEndpoint || COPILOT_BASE_URL;
}

/** The headers every Copilot chat carries (github-copilot.ts `applyHeaders`).
 *  A chat turn is the person's own, so the initiator is `user`. */
export function copilotChatHeaders(): Record<string, string> {
    return {
        "Openai-Intent": "conversation-edits",
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
        "x-initiator": "user"
    };
}
