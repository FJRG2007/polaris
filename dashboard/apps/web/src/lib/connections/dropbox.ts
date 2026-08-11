/**
 * Dropbox accounts, for Dropbox as a backup destination.
 *
 * The app is the operator's, connected in Admin like the others. Two details
 * differ from the rest and both are easy to get wrong:
 *
 *  - A refresh token is only returned when the authorization asks for
 *    `token_access_type=offline`. Without it the link works for four hours and
 *    then quietly stops, which looks like a broken destination rather than an
 *    expired grant.
 *  - An app scoped to its own folder is the recommended setup and the one worth
 *    encouraging: everything Polaris writes then lives in one folder somebody
 *    can see, and nothing else in their Dropbox is reachable from here.
 */

import { z } from "zod";
import { refusalMessage } from "./refusal";
import type { ConnectionCredential } from "./store";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

export const DROPBOX_PROVIDER = "dropbox";

const AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";
const CURRENT_ACCOUNT = "https://api.dropboxapi.com/2/users/get_current_account";

/** Write the files, read them back, and see how much room is left. */
export const DROPBOX_SCOPES = [
    "account_info.read",
    "files.metadata.read",
    "files.metadata.write",
    "files.content.read",
    "files.content.write"
];

/** Naming the account is all a sign-in needs. */
export const DROPBOX_SIGN_IN_SCOPES = ["account_info.read"];

export interface DropboxOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The app an operator connected, or null when this deployment has none. */
export async function getDropboxOAuthClient(): Promise<DropboxOAuthClient | null> {
    const state = await getIntegrationState(DROPBOX_PROVIDER);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(DROPBOX_PROVIDER);
    return clientSecret ? { clientId, clientSecret } : null;
}

export function dropboxAuthorizeUrl(
    client: DropboxOAuthClient,
    redirectUri: string,
    state: string,
    flow: "link" | "signin" | "storage" = "link"
): string {
    const signIn = flow === "signin";
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (signIn ? DROPBOX_SIGN_IN_SCOPES : DROPBOX_SCOPES).join(" "));
    // Without this the grant lasts hours rather than until it is revoked.
    if (!signIn) url.searchParams.set("token_access_type", "offline");
    url.searchParams.set("state", state);
    return url.toString();
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    account_id: z.string().optional()
});

const accountSchema = z.object({
    account_id: z.string().min(1),
    email: z.string().trim().toLowerCase().pipe(z.string().email()).optional(),
    email_verified: z.boolean().optional(),
    name: z.object({ display_name: z.string().optional() }).optional()
});

export interface DropboxAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly email: string | null;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

async function postToken(
    client: DropboxOAuthClient,
    body: Record<string, string>
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            // Dropbox takes the app's credentials as basic auth on this endpoint.
            authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`
        },
        body: new URLSearchParams(body)
    });
    if (!response.ok) throw new Error(await refusalMessage(response, "Dropbox refused the token request"));
    return tokenSchema.parse(await response.json());
}

/** Spend the code and read back who authorized. */
export async function exchangeDropboxCode(
    client: DropboxOAuthClient,
    code: string,
    redirectUri: string
): Promise<DropboxAuthorization> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
    });
    if (!token.refresh_token) {
        throw new Error(
            "Dropbox did not return a refresh token. The app must request offline access; link the account again."
        );
    }
    const account = await identify(token.access_token);
    return {
        accountId: account.account_id,
        label: account.email ?? account.name?.display_name ?? account.account_id,
        // Only an address Dropbox says it has confirmed.
        email: account.email_verified ? (account.email ?? null) : null,
        scope: token.scope ?? DROPBOX_SCOPES.join(" "),
        credential: {
            refreshToken: token.refresh_token,
            accessToken: token.access_token,
            ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {})
        }
    };
}

/** The same round trip, for a sign-in that only has to name the account. */
export async function identifyDropboxAccount(
    client: DropboxOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
    });
    const account = await identify(token.access_token);
    return { accountId: account.account_id };
}

async function identify(accessToken: string): Promise<z.infer<typeof accountSchema>> {
    const response = await fetch(CURRENT_ACCOUNT, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(await refusalMessage(response, "Dropbox would not say who authorized"));
    return accountSchema.parse(await response.json());
}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/** A currently-valid access token for a stored refresh token. */
export async function dropboxAccessToken(client: DropboxOAuthClient, refreshToken: string): Promise<string> {
    const cached = accessTokens.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    let token: z.infer<typeof tokenSchema>;
    try {
        token = await postToken(client, { grant_type: "refresh_token", refresh_token: refreshToken });
    } catch (error) {
        throw new DropboxAuthExpiredError((error as Error).message);
    }
    const ttl = (token.expires_in ?? 14_400) * 1000;
    accessTokens.set(refreshToken, { token: token.access_token, expiresAt: Date.now() + Math.max(0, ttl) });
    return token.access_token;
}

/** Forget a cached token, for when its refresh token is being discarded. */
export function forgetDropboxAccessToken(refreshToken: string): void {
    accessTokens.delete(refreshToken);
}

/** Raised when Dropbox has stopped accepting the stored refresh token. */
export class DropboxAuthExpiredError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "DropboxAuthExpiredError";
    }
}
