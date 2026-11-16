/**
 * Signing in to GitHub Copilot from the Polaris server: GitHub's device flow,
 * ported from OpenCode's provider (`packages/core/src/plugin/provider/github-copilot.ts`),
 * on GitHub.com or a GitHub Enterprise domain (`company.ghe.com`), whose
 * sign-in, API and Copilot API are the domain itself and its `api.` and
 * `copilot-api.` hosts (OpenCode's `oauthURLs`, `userURL`, `baseURL`). The
 * domain is kept on the login (`metadata.enterpriseUrl`, as OpenCode keeps it).
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
import { copilotDomain } from "@/lib/agents/login-instances";

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

/** Where a login on a domain signs in and reads its account; GitHub.com's
 *  when there is none. */
export function copilotUrls(domain: string | null): { device: string; token: string; user: string } {
    if (!domain) return { device: COPILOT_DEVICE_URL, token: COPILOT_TOKEN_URL, user: COPILOT_USER_URL };
    return {
        device: `https://${domain}/login/device/code`,
        token: `https://${domain}/login/oauth/access_token`,
        user: `https://api.${domain}/copilot_internal/user`
    };
}

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
    /** The GitHub Enterprise domain; absent on GitHub.com. */
    readonly domain?: string;
}

/** A finished login: the GitHub token, the account's API address when
 *  GitHub named one, and the Enterprise domain it was made on. */
export interface CopilotLogin {
    readonly token: string;
    readonly apiEndpoint: string | null;
    readonly enterpriseUrl?: string;
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

export async function requestCopilotDevice(
    request: LoginRequest,
    now: number,
    domain: string | null = null
): Promise<CopilotDevice> {
    const response = await request(copilotUrls(domain).device, {
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
        expiresAt: now + DEVICE_LIFETIME_MS,
        ...(domain ? { domain } : {})
    };
}

/** One poll. GitHub answers 200 with an `error` while the code waits. */
export async function pollCopilotDevice(
    request: LoginRequest,
    device: CopilotDevice,
    now: number
): Promise<CopilotPoll> {
    if (now >= device.expiresAt) return { state: "expired" };
    const urls = copilotUrls(device.domain ?? null);
    const response = await request(urls.token, {
        method: "POST",
        headers: JSON_HEADERS,
        json: { client_id: COPILOT_CLIENT_ID, device_code: device.deviceCode, grant_type: DEVICE_GRANT }
    });
    if (!ok(response.status)) throw new DirectSigninError(`copilot device token: HTTP ${response.status}`);
    const parsed = tokenSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("copilot device token: unexpected answer");
    const { access_token: token, error } = parsed.data;
    if (token) return copilotAccount(request, token, device.domain ?? null);
    if (error === "authorization_pending") return { state: "pending" };
    if (error === "slow_down") return { state: "slower" };
    if (error === "access_denied") return { state: "denied" };
    if (error === "expired_token") return { state: "expired" };
    throw new DirectSigninError(`copilot device token: ${error ?? "unexpected answer"}`);
}

/** The account behind a fresh token. Only an explicit "no chat" refuses the
 *  login; a failed or malformed lookup must not turn a GitHub hiccup into a
 *  denial (github-copilot.ts, the comment over `orElseSucceed`). */
async function copilotAccount(request: LoginRequest, token: string, domain: string | null): Promise<CopilotPoll> {
    const user = await request(copilotUrls(domain).user, {
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
    const login = { token, apiEndpoint: api && api.startsWith("https://") ? api : null };
    return { state: "done", login: domain ? { ...login, enterpriseUrl: domain } : login };
}

/** Where a chat is sent: the account's own address when GitHub named one,
 *  else its Enterprise domain's Copilot API, else GitHub.com's (OpenCode's
 *  `copilotBaseURL`). A stored domain is read through the typed rules again. */
export function copilotBaseUrl(apiEndpoint: string | null | undefined, enterpriseUrl?: string | null): string {
    if (apiEndpoint) return apiEndpoint;
    const domain = enterpriseUrl ? copilotDomain(enterpriseUrl) : null;
    return domain ? `https://copilot-api.${domain}` : COPILOT_BASE_URL;
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

/** The Copilot API a model answers on. */
export type CopilotEndpoint = "responses" | "chat";

/**
 * Which Copilot API serves a model, by its id. Copilot serves GPT-5 and later
 * (GPT-5 mini aside), Grok and MAI Code only on `/responses`, and the rest on
 * `/chat/completions` (OpenCode's `github-copilot/models.ts` `fallbackEndpoint`).
 * Pure.
 */
export function copilotEndpoint(model: string): CopilotEndpoint {
    const gpt = /^gpt-(\d+)/.exec(model);
    if (gpt && Number(gpt[1]) >= 5 && !model.startsWith("gpt-5-mini")) return "responses";
    if (model.startsWith("grok-") || model.startsWith("mai-code-")) return "responses";
    return "chat";
}

/** Whether a catalogue model is offered on Copilot. `gpt-5-chat-latest` is a
 *  chat-only alias that collides with GPT-5's `/responses` route, so it is left
 *  out for Copilot alone, as OpenCode does. Pure. */
export function copilotListsModel(model: string): boolean {
    return model !== "gpt-5-chat-latest";
}
