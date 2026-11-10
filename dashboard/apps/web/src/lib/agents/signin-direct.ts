/**
 * Signing in straight from the Polaris server, with no container at all.
 *
 * The most comfortable rung of the sign-in ladder: the vendor's device-code
 * endpoints, called from here, so the dialog has an address and a code within a
 * second instead of after a minute of installing a CLI. Only for a vendor whose
 * endpoints and client id are written down in a source somebody can check -
 * every constant below names the line it was copied from. A vendor with no such
 * source has no direct rung, and its sign-in starts at the CLI.
 *
 * When this fails in any way - the endpoint moved, it answered 4xx, the network
 * is down - the caller falls back to running the vendor's own CLI, so a change
 * on the vendor's side costs a slower sign-in, never a broken one.
 *
 * Pure apart from the `post` it is handed, so the flow is asserted here
 * without the network.
 */

// From references/repos/free-claude-code/src/free_claude_code/providers/
// openai_codex/login.py, lines 15-26, which mirror the Codex CLI's own login.
export const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/oauth/token`;
export const OPENAI_DEVICE_USER_CODE_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const OPENAI_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_ISSUER}/codex/device`;
export const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_AUTH_ISSUER}/deviceauth/callback`;

/** login.py line 28: a device code lives fifteen minutes. */
export const DEVICE_LIFETIME_MS = 15 * 60 * 1000;

/** One request's answer, as much of it as this needs. */
export interface DirectResponse {
    readonly status: number;
    readonly json: unknown;
}

/** How a request goes out. The real one is the guarded fetch with a timeout;
 *  a test hands in its own. */
export type DirectPost = (
    url: string,
    body: { readonly json: Record<string, string> } | { readonly form: Record<string, string> }
) => Promise<DirectResponse>;

/** A failure of the direct rung, which the caller answers by falling back. */
export class DirectSigninError extends Error {}

/** A device code waiting for the person to approve it. */
export interface DeviceAuthorization {
    readonly verificationUrl: string;
    readonly userCode: string;
    readonly deviceAuthId: string;
    readonly intervalMs: number;
    readonly expiresAt: number;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function ok(status: number): boolean {
    return status >= 200 && status < 300;
}

/** login.py `request_device_authorization`, lines 179-204. */
export async function requestDeviceAuthorization(
    post: DirectPost,
    now: number
): Promise<DeviceAuthorization> {
    const response = await post(OPENAI_DEVICE_USER_CODE_URL, {
        json: { client_id: OPENAI_OAUTH_CLIENT_ID }
    });
    if (!ok(response.status)) throw new DirectSigninError(`device code: HTTP ${response.status}`);
    const payload = record(response.json);
    const deviceAuthId = payload.device_auth_id;
    const userCode = payload.user_code ?? payload.usercode;
    if (typeof deviceAuthId !== "string" || typeof userCode !== "string" || !userCode.trim()) {
        throw new DirectSigninError("device code: unexpected answer");
    }
    const interval = Number(payload.interval ?? 5);
    return {
        verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
        userCode: userCode.trim(),
        deviceAuthId,
        intervalMs: Math.max(1, Number.isFinite(interval) ? interval : 5) * 1000,
        expiresAt: now + DEVICE_LIFETIME_MS
    };
}

/** What the token endpoint hands back once the person has approved. */
export interface AuthorizationGrant {
    readonly code: string;
    readonly codeVerifier: string;
}

/**
 * One poll of the device token endpoint: the grant once approved, null while
 * it is still waiting (403 and 404, login.py line 234), and a throw for
 * anything else.
 */
export async function pollDeviceGrant(
    post: DirectPost,
    device: DeviceAuthorization
): Promise<AuthorizationGrant | null> {
    const response = await post(OPENAI_DEVICE_TOKEN_URL, {
        json: { device_auth_id: device.deviceAuthId, user_code: device.userCode }
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!ok(response.status)) throw new DirectSigninError(`device token: HTTP ${response.status}`);
    const payload = record(response.json);
    const code = payload.authorization_code;
    const codeVerifier = payload.code_verifier;
    if (typeof code !== "string" || typeof codeVerifier !== "string") {
        throw new DirectSigninError("device token: unexpected answer");
    }
    return { code, codeVerifier };
}

/** The three tokens a finished login holds. */
export interface OpenAITokens {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly idToken: string;
}

/** auth.py `_exchange_code`, lines 442-455: form-encoded, with the device
 *  flow's own redirect address. */
export async function exchangeGrant(post: DirectPost, grant: AuthorizationGrant): Promise<OpenAITokens> {
    const response = await post(OPENAI_TOKEN_URL, {
        form: {
            grant_type: "authorization_code",
            client_id: OPENAI_OAUTH_CLIENT_ID,
            code: grant.code,
            redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
            code_verifier: grant.codeVerifier
        }
    });
    if (!ok(response.status)) throw new DirectSigninError(`token exchange: HTTP ${response.status}`);
    const payload = record(response.json);
    const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken } = payload;
    if (
        typeof accessToken !== "string" ||
        !accessToken ||
        typeof refreshToken !== "string" ||
        !refreshToken ||
        typeof idToken !== "string" ||
        !idToken
    ) {
        throw new DirectSigninError("token exchange: missing tokens");
    }
    return { accessToken, refreshToken, idToken };
}

/** A JWT's claims, or an empty object for one that does not decode. Read only
 *  to find the account id and the address - never trusted for anything else,
 *  since the token came straight from the issuer over TLS. */
export function jwtClaims(token: string): Record<string, unknown> {
    const part = token.split(".")[1];
    if (!part) return {};
    try {
        return record(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    } catch {
        return {};
    }
}

/** auth.py lines 73-84: the ChatGPT account id from the access token's auth
 *  claim, else the id token's; the address from the id token. */
export function tokenIdentity(tokens: OpenAITokens): { accountId: string | null; email: string | null } {
    const access = jwtClaims(tokens.accessToken);
    const id = jwtClaims(tokens.idToken);
    const authOf = (claims: Record<string, unknown>) => record(claims["https://api.openai.com/auth"]);
    const account = authOf(access).chatgpt_account_id ?? authOf(id).chatgpt_account_id;
    const profile = record(id["https://api.openai.com/profile"]);
    const email = id.email ?? profile.email;
    return {
        accountId: typeof account === "string" && account ? account : null,
        email: typeof email === "string" && email ? email : null
    };
}

/**
 * The `~/.codex/auth.json` the Codex CLI reads, as the base64 Polaris stores.
 *
 * Shape from openai/codex `codex-rs/login/src/auth/storage.rs` (`AuthDotJson`:
 * `OPENAI_API_KEY`, `tokens`, `last_refresh`, the rest optional and omitted) and
 * `codex-rs/login/src/token_data.rs` (`TokenData`: `id_token` as the raw JWT,
 * `access_token`, `refresh_token`, `account_id`). The CLI refreshes the tokens
 * itself from here on, exactly as it does after its own login.
 */
export function codexAuthFile(tokens: OpenAITokens, now: Date): string {
    const { accountId } = tokenIdentity(tokens);
    const file = {
        OPENAI_API_KEY: null,
        tokens: {
            id_token: tokens.idToken,
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            account_id: accountId
        },
        last_refresh: now.toISOString()
    };
    return Buffer.from(JSON.stringify(file), "utf8").toString("base64");
}

/** Which credentials have a direct rung. Anything absent starts at the CLI. */
export function hasDirectSignin(env: string): boolean {
    return env === "CODEX_CHATGPT_AUTH";
}
