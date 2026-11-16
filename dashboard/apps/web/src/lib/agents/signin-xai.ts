/**
 * Signing in to a SuperGrok subscription from the Polaris server: xAI's
 * device-code login, ported from OpenCode's provider
 * (`packages/core/src/plugin/provider/xai.ts`). The access token it ends with
 * is a bearer on `https://api.x.ai/v1`, the endpoint Polar already calls with
 * an xAI key, and it is refreshed with the refresh token before it expires.
 *
 * Pure apart from the `post` it is handed (the same shape as the ChatGPT
 * login's in `signin-direct.ts`), so every step is asserted without the
 * network. Every answer is read through a schema; anything else is a
 * `DirectSigninError`.
 *
 * Not wired to a screen or the credential store yet (see OC2A-PLAN.md).
 */

import { z } from "zod";
import { DirectSigninError, jwtClaims, type DirectPost } from "@/lib/agents/signin-direct";

// xai.ts lines 9-12.
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_ISSUER = "https://auth.x.ai/oauth2";
export const XAI_DEVICE_CODE_URL = `${XAI_ISSUER}/device/code`;
export const XAI_TOKEN_URL = `${XAI_ISSUER}/token`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

/** xai.ts `positiveSeconds(value.expires_in, 300)`: a code with no stated
 *  lifetime is given five minutes. */
const DEFAULT_DEVICE_SECONDS = 300;
/** xai.ts `tokenExpiration`: an hour when neither the answer nor the JWT says. */
const DEFAULT_TOKEN_SECONDS = 3600;

const deviceSchema = z.object({
    device_code: z.string().min(1),
    user_code: z.string().min(1),
    verification_uri: z.string().url(),
    verification_uri_complete: z.string().url().optional(),
    expires_in: z.number().positive().optional(),
    interval: z.number().positive().optional()
});

const tokenSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().positive().optional()
});

const errorSchema = z.object({ error: z.string().optional() });

/** A device code waiting for the person to approve it. */
export interface XaiDevice {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUrl: string;
    readonly intervalMs: number;
    readonly expiresAt: number;
}

/** A finished login. `expires` is epoch milliseconds. */
export interface XaiTokens {
    readonly access: string;
    readonly refresh: string;
    readonly expires: number;
}

function ok(status: number): boolean {
    return status >= 200 && status < 300;
}

/** Step one: a code to show and the address to approve it at. */
export async function requestXaiDevice(post: DirectPost, now: number): Promise<XaiDevice> {
    const response = await post(XAI_DEVICE_CODE_URL, {
        form: { client_id: XAI_OAUTH_CLIENT_ID, scope: SCOPE, referrer: "opencode" }
    });
    if (!ok(response.status)) throw new DirectSigninError(`xai device code: HTTP ${response.status}`);
    const parsed = deviceSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("xai device code: unexpected answer");
    const device = parsed.data;
    return {
        deviceCode: device.device_code,
        userCode: device.user_code,
        verificationUrl: device.verification_uri_complete ?? device.verification_uri,
        intervalMs: Math.max(1, device.interval ?? 5) * 1000,
        expiresAt: now + (device.expires_in ?? DEFAULT_DEVICE_SECONDS) * 1000
    };
}

/** When a token stops working: the answer's `expires_in`, else the JWT's
 *  `exp`, else an hour (xai.ts `tokenExpiration`). */
function expiryOf(access: string, expiresIn: number | undefined, now: number): number {
    if (expiresIn) return now + expiresIn * 1000;
    const exp = jwtClaims(access).exp;
    return typeof exp === "number" && exp > 0 ? exp * 1000 : now + DEFAULT_TOKEN_SECONDS * 1000;
}

function tokensOf(json: unknown, now: number, currentRefresh?: string): XaiTokens {
    const parsed = tokenSchema.safeParse(json);
    if (!parsed.success) throw new DirectSigninError("xai token: unexpected answer");
    const refresh = parsed.data.refresh_token ?? currentRefresh;
    if (!refresh) throw new DirectSigninError("xai token: no refresh token");
    return {
        access: parsed.data.access_token,
        refresh,
        expires: expiryOf(parsed.data.access_token, parsed.data.expires_in, now)
    };
}

/** What one poll found. `slower` asks for five more seconds between polls. */
export type XaiPoll =
    | { readonly state: "done"; readonly tokens: XaiTokens }
    | { readonly state: "pending" | "slower" }
    | { readonly state: "denied" | "expired" };

/** One poll of the token endpoint (xai.ts `poll`). */
export async function pollXaiDevice(post: DirectPost, device: XaiDevice, now: number): Promise<XaiPoll> {
    if (now >= device.expiresAt) return { state: "expired" };
    const response = await post(XAI_TOKEN_URL, {
        form: { grant_type: DEVICE_GRANT, client_id: XAI_OAUTH_CLIENT_ID, device_code: device.deviceCode }
    });
    if (ok(response.status)) return { state: "done", tokens: tokensOf(response.json, now) };
    const error = errorSchema.safeParse(response.json);
    const code = error.success ? error.data.error : undefined;
    if (code === "authorization_pending") return { state: "pending" };
    if (code === "slow_down") return { state: "slower" };
    if (code === "access_denied" || code === "authorization_denied") return { state: "denied" };
    if (code === "expired_token") return { state: "expired" };
    throw new DirectSigninError(`xai device token: HTTP ${response.status}`);
}

/** A fresh access token from the refresh token (xai.ts `refresh`). xAI may or
 *  may not rotate the refresh token; the old one is kept when it does not. */
export async function refreshXaiTokens(post: DirectPost, tokens: XaiTokens, now: number): Promise<XaiTokens> {
    const response = await post(XAI_TOKEN_URL, {
        form: { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: XAI_OAUTH_CLIENT_ID }
    });
    if (!ok(response.status)) throw new DirectSigninError(`xai refresh: HTTP ${response.status}`);
    return tokensOf(response.json, now, tokens.refresh);
}

/** Whether a token needs refreshing before a call: within five minutes of its end. */
export function xaiNeedsRefresh(tokens: XaiTokens, now: number): boolean {
    return tokens.expires - now < 5 * 60_000;
}
