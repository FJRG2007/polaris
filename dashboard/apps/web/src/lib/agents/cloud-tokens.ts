/**
 * The short-lived tokens two cloud accounts are spent through:
 *
 *   - Azure (Microsoft Entra ID): client credentials exchanged at the tenant's
 *     v2.0 token endpoint for a token on the Cognitive Services scope
 *     (learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow).
 *   - Google Vertex AI: a service account's own JWT, signed RS256 with its
 *     private key, exchanged at Google's token endpoint
 *     (developers.google.com/identity/protocols/oauth2/service-account#httprest).
 *
 * Tokens are held in memory only, by a hash of the credential, and asked for
 * again five minutes before they end; concurrent turns on one credential share
 * one request. Nothing here is written anywhere or logged.
 *
 * Server-only.
 */

import { z } from "zod";
import { createHash, createSign } from "node:crypto";

export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;

const plainFetch: TokenFetch = (url, init) => fetch(url, init);

export const AZURE_COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const TIMEOUT_MS = 15_000;
const RENEW_BEFORE_MS = 5 * 60_000;
const MAX_HELD = 1000;

/** Why a token could not be had: the vendor refused the credential, or could
 *  not be asked. Carries no response body: those can echo what was sent. */
export class CloudTokenError extends Error {
    constructor(readonly reason: "refused" | "unreachable") {
        super(`cloud token ${reason}`);
        this.name = "CloudTokenError";
    }
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    expires_in: z.coerce.number().positive()
});

interface Held {
    until: number;
    value: Promise<{ token: string; until: number }>;
}
const held = new Map<string, Held>();

/** Forget every held token (tests). */
export function forgetCloudTokens(): void {
    held.clear();
}

function cacheKey(parts: readonly string[]): string {
    return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

async function cached(
    key: string,
    now: number,
    ask: () => Promise<{ token: string; until: number }>
): Promise<string> {
    const current = held.get(key);
    if (current && current.until - RENEW_BEFORE_MS > now) return (await current.value).token;
    if (held.size >= MAX_HELD) held.clear();
    const value = ask();
    // Until it answers, a concurrent turn waits on this same request.
    const entry: Held = { until: Number.POSITIVE_INFINITY, value };
    held.set(key, entry);
    try {
        const answer = await value;
        entry.until = answer.until;
        return answer.token;
    } catch (caught) {
        if (held.get(key) === entry) held.delete(key);
        throw caught;
    }
}

async function exchange(request: TokenFetch, url: string, form: URLSearchParams, now: number) {
    let response: Response;
    try {
        response = await request(url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: form.toString(),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new CloudTokenError("unreachable");
    }
    if (response.status >= 400 && response.status < 500) throw new CloudTokenError("refused");
    if (!response.ok) throw new CloudTokenError("unreachable");
    const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new CloudTokenError("unreachable");
    return { token: parsed.data.access_token, until: now + parsed.data.expires_in * 1000 };
}

export interface EntraClient {
    readonly tenantId: string;
    readonly clientId: string;
    readonly clientSecret: string;
}

/** A Microsoft Entra token for Azure OpenAI, from client credentials. */
export function entraToken(client: EntraClient, request: TokenFetch = plainFetch, now = Date.now()): Promise<string> {
    const key = cacheKey(["entra", client.tenantId, client.clientId, client.clientSecret]);
    return cached(key, now, () =>
        exchange(
            request,
            `https://login.microsoftonline.com/${encodeURIComponent(client.tenantId)}/oauth2/v2.0/token`,
            new URLSearchParams({
                client_id: client.clientId,
                client_secret: client.clientSecret,
                scope: AZURE_COGNITIVE_SCOPE,
                grant_type: "client_credentials"
            }),
            now
        )
    );
}

export interface ServiceAccount {
    readonly client_email: string;
    readonly private_key: string;
    readonly private_key_id?: string;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The signed assertion a service account trades for a token. Pure but for the
 *  key, which signs it. */
export function serviceAccountAssertion(account: ServiceAccount, now: number): string {
    const iat = Math.floor(now / 1000);
    const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
    const claims = {
        iss: account.client_email,
        scope: GOOGLE_CLOUD_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat,
        exp: iat + 3600
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
    return `${unsigned}.${base64url(signature)}`;
}

/** A Google OAuth token for Vertex AI, from a service account. */
export function googleServiceToken(
    account: ServiceAccount,
    request: TokenFetch = plainFetch,
    now = Date.now()
): Promise<string> {
    const key = cacheKey(["google", account.client_email, account.private_key]);
    return cached(key, now, async () => {
        let assertion: string;
        try {
            assertion = serviceAccountAssertion(account, now);
        } catch {
            // A private key that does not parse is a credential Google would refuse.
            throw new CloudTokenError("refused");
        }
        return exchange(
            request,
            GOOGLE_TOKEN_URL,
            new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
            now
        );
    });
}
