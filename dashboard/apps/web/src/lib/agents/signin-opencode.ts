/**
 * Signing in to an OpenCode Console account from the Polaris server: the
 * Console's device login, ported from OpenCode's provider
 * (`packages/core/src/plugin/provider/opencode.ts`, `console-access.ts`,
 * `usage-limits.ts`).
 *
 * The access token it ends with is the bearer on Zen and Go, the endpoints Polar
 * already calls with a Console key, and it is refreshed with the refresh token
 * before it ends. The workspace the sign-in chose is kept as `orgID` and sent
 * as `x-opencode-org-id` on Go's usage.
 *
 * Pure apart from the `request` it is handed, so every step is asserted
 * against recorded answers.
 */

import { z } from "zod";
import { DirectSigninError } from "@/lib/agents/signin-direct";
import type { StoredOAuth } from "@/lib/agents/provider-oauth";
import type { LoginRequest } from "@/lib/agents/provider-login-http";

// opencode.ts line 36 and console-access.ts `defaultServer`.
export const OPENCODE_CLIENT_ID = "opencode-cli";
export const OPENCODE_CONSOLE = "https://opencode.ai/console";
export const OPENCODE_DEVICE_URL = `${OPENCODE_CONSOLE}/auth/device/code`;
export const OPENCODE_TOKEN_URL = `${OPENCODE_CONSOLE}/auth/device/token`;
export const OPENCODE_USER_URL = `${OPENCODE_CONSOLE}/api/user`;
export const OPENCODE_ORGS_URL = `${OPENCODE_CONSOLE}/api/orgs`;
// usage-limits.ts `readGo`: the inference API on the Console's origin.
export const OPENCODE_GO_USAGE_URL = `${new URL(OPENCODE_CONSOLE).origin}/zen/go/v1/usage`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

const deviceSchema = z.object({
    device_code: z.string().min(1),
    user_code: z.string().min(1),
    verification_uri_complete: z.string().min(1),
    expires_in: z.number().positive(),
    interval: z.number().nonnegative()
});

const tokenSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().positive(),
    org_id: z.string().min(1).nullish()
});

const pendingSchema = z.object({ error: z.string() });
const userSchema = z.object({ id: z.string(), email: z.string() });
const orgsSchema = z.array(z.object({ id: z.string(), name: z.string() }));

const meterSchema = z.object({
    status: z.enum(["ok", "rate-limited"]),
    percent: z.number().finite(),
    resetsAt: z.string().min(1)
});
const goUsageSchema = z.object({
    usage: z.object({ rolling: meterSchema, weekly: meterSchema, monthly: meterSchema })
});

export interface OpencodeDevice {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUrl: string;
    readonly intervalMs: number;
    readonly expiresAt: number;
}

export type OpencodePoll =
    | { readonly state: "done"; readonly login: Omit<StoredOAuth, "kind"> }
    | { readonly state: "pending" | "slower" }
    | { readonly state: "denied" | "expired" };

function ok(status: number): boolean {
    return status >= 200 && status < 300;
}

export async function requestOpencodeDevice(request: LoginRequest, now: number): Promise<OpencodeDevice> {
    const response = await request(OPENCODE_DEVICE_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        json: { client_id: OPENCODE_CLIENT_ID, supports_org_scope: true }
    });
    if (!ok(response.status)) throw new DirectSigninError(`opencode device code: HTTP ${response.status}`);
    const parsed = deviceSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("opencode device code: unexpected answer");
    // opencode.ts: the address is read against the Console and must be HTTP(S);
    // only HTTPS is opened from here.
    let url: URL;
    try {
        url = new URL(parsed.data.verification_uri_complete, `${OPENCODE_CONSOLE}/`);
    } catch {
        throw new DirectSigninError("opencode device code: bad verification address");
    }
    if (url.protocol !== "https:") throw new DirectSigninError("opencode device code: bad verification address");
    return {
        deviceCode: parsed.data.device_code,
        userCode: parsed.data.user_code,
        verificationUrl: url.href,
        intervalMs: Math.max(parsed.data.interval, 1) * 1000,
        expiresAt: now + parsed.data.expires_in * 1000
    };
}

/** One poll. The Console answers a waiting code with an `error`, on any status. */
export async function pollOpencodeDevice(
    request: LoginRequest,
    device: OpencodeDevice,
    now: number
): Promise<OpencodePoll> {
    if (now >= device.expiresAt) return { state: "expired" };
    const response = await request(OPENCODE_TOKEN_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        json: { grant_type: DEVICE_GRANT, device_code: device.deviceCode, client_id: OPENCODE_CLIENT_ID }
    });
    const token = tokenSchema.safeParse(response.json);
    if (token.success && ok(response.status)) {
        return { state: "done", login: await opencodeAccount(request, token.data, now) };
    }
    const pending = pendingSchema.safeParse(response.json);
    const error = pending.success ? pending.data.error : null;
    if (error === "authorization_pending") return { state: "pending" };
    if (error === "slow_down") return { state: "slower" };
    if (error === "access_denied") return { state: "denied" };
    if (error === "expired_token") return { state: "expired" };
    throw new DirectSigninError(`opencode device token: ${error ?? `HTTP ${response.status}`}`);
}

async function getJson(request: LoginRequest, url: string, token: string): Promise<unknown> {
    const response = await request(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
    });
    if (!ok(response.status)) throw new DirectSigninError(`opencode account: HTTP ${response.status}`);
    return response.json;
}

/** The account and workspace behind a fresh token (opencode.ts `credential`):
 *  the workspace the sign-in chose, else the first by name. */
async function opencodeAccount(
    request: LoginRequest,
    token: z.infer<typeof tokenSchema>,
    now: number
): Promise<Omit<StoredOAuth, "kind">> {
    const [userAnswer, orgsAnswer] = await Promise.all([
        getJson(request, OPENCODE_USER_URL, token.access_token),
        getJson(request, OPENCODE_ORGS_URL, token.access_token)
    ]);
    const user = userSchema.safeParse(userAnswer);
    const orgs = orgsSchema.safeParse(orgsAnswer);
    if (!user.success || !orgs.success) throw new DirectSigninError("opencode account: unexpected answer");
    const org = token.org_id
        ? orgs.data.find((entry) => entry.id === token.org_id)
        : [...orgs.data].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
    if (token.org_id && !org) throw new DirectSigninError("opencode account: organization not found");
    return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: now + token.expires_in * 1000,
        metadata: {
            accountID: user.data.id,
            email: user.data.email,
            ...(org ? { orgID: org.id, orgName: org.name } : {})
        }
    };
}

/** A renewed login (opencode.ts `refresh`). A refused refresh token means the
 *  Console signed the account out, and only a new sign-in recovers it. */
export async function refreshOpencodeTokens(
    request: LoginRequest,
    login: StoredOAuth,
    now: number
): Promise<Pick<StoredOAuth, "access" | "refresh" | "expires" | "metadata">> {
    const response = await request(OPENCODE_TOKEN_URL, {
        method: "POST",
        headers: JSON_HEADERS,
        json: { grant_type: "refresh_token", refresh_token: login.refresh, client_id: OPENCODE_CLIENT_ID }
    });
    if (!ok(response.status)) throw new DirectSigninError(`opencode refresh: HTTP ${response.status}`);
    const parsed = tokenSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("opencode refresh: unexpected answer");
    const metadata = { ...login.metadata };
    if (parsed.data.org_id && parsed.data.org_id !== metadata.orgID) {
        metadata.orgID = parsed.data.org_id;
        metadata.orgName = parsed.data.org_id;
    }
    return {
        access: parsed.data.access_token,
        refresh: parsed.data.refresh_token,
        expires: now + parsed.data.expires_in * 1000,
        metadata
    };
}

/** One of Go's three allowances: how much is used and when it starts over. */
export interface GoMeter {
    readonly percent: number;
    readonly limited: boolean;
    readonly resetsAt: number;
}

export interface GoUsage {
    readonly rolling: GoMeter;
    readonly weekly: GoMeter;
    readonly monthly: GoMeter;
}

/**
 * The Go allowance of the workspace a login chose, or null when that workspace
 * has no Go (the 403 `usage-limits.ts` reads as "nothing to show") or the login
 * names no workspace. Anything else unexpected throws.
 */
export async function readGoUsage(
    request: LoginRequest,
    token: string,
    orgID: string | undefined
): Promise<GoUsage | null> {
    if (!orgID) return null;
    const response = await request(OPENCODE_GO_USAGE_URL, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "x-opencode-org-id": orgID }
    });
    if (response.status === 403) return null;
    if (!ok(response.status)) throw new DirectSigninError(`opencode go usage: HTTP ${response.status}`);
    const parsed = goUsageSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("opencode go usage: unexpected answer");
    const meter = (value: z.infer<typeof meterSchema>): GoMeter => {
        const resetsAt = Date.parse(value.resetsAt);
        if (Number.isNaN(resetsAt)) throw new DirectSigninError("opencode go usage: unexpected answer");
        return { percent: value.percent, limited: value.status === "rate-limited", resetsAt };
    };
    const { rolling, weekly, monthly } = parsed.data.usage;
    return { rolling: meter(rolling), weekly: meter(weekly), monthly: meter(monthly) };
}
