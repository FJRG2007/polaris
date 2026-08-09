/**
 * Microsoft accounts, for OneDrive as a backup destination.
 *
 * The application is the operator's, registered in Entra and connected in Admin
 * exactly like the GitHub and Google ones - Polaris holds no client of its own,
 * so an instance nobody has configured offers the button as unavailable rather
 * than as one that could only fail.
 *
 * `/common` is the tenant, so both a personal Microsoft account and a work one
 * can authorize. `offline_access` is what returns a refresh token, and without
 * it the destination stops writing an hour after somebody connects it.
 */

import { z } from "zod";
import type { ConnectionCredential } from "./store";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

export const MICROSOFT_PROVIDER = "microsoft";

const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

/** Read and write the files this application creates, and learn who authorized.
 *  `Files.ReadWrite` is the least privilege that can store a backup. */
export const MICROSOFT_SCOPES = ["openid", "email", "offline_access", "Files.ReadWrite"];

/** Naming the account is all a sign-in needs. */
export const MICROSOFT_SIGN_IN_SCOPES = ["openid", "email"];

export interface MicrosoftOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The application an operator connected, or null when this deployment has none. */
export async function getMicrosoftOAuthClient(): Promise<MicrosoftOAuthClient | null> {
    const state = await getIntegrationState(MICROSOFT_PROVIDER);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(MICROSOFT_PROVIDER);
    return clientSecret ? { clientId, clientSecret } : null;
}

export function microsoftAuthorizeUrl(
    client: MicrosoftOAuthClient,
    redirectUri: string,
    state: string,
    flow: "link" | "signin" | "storage" = "link"
): string {
    const signIn = flow === "signin";
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (signIn ? MICROSOFT_SIGN_IN_SCOPES : MICROSOFT_SCOPES).join(" "));
    // An account chooser for a sign-in; a fresh consent when lasting access to
    // somebody's files is being asked for, so it is never granted silently.
    url.searchParams.set("prompt", signIn ? "select_account" : "consent");
    url.searchParams.set("state", state);
    return url.toString();
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional()
});

const meSchema = z.object({
    id: z.string().min(1),
    displayName: z.string().optional(),
    userPrincipalName: z.string().optional(),
    mail: z.string().trim().toLowerCase().pipe(z.string().email()).optional()
});

export interface MicrosoftAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly email: string | null;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

async function postToken(
    client: MicrosoftOAuthClient,
    body: Record<string, string>
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            ...body
        })
    });
    if (!response.ok) {
        throw new Error(`Microsoft refused the token request (${response.status})`);
    }
    return tokenSchema.parse(await response.json());
}

/** Spend the code and read back who authorized. */
export async function exchangeMicrosoftCode(
    client: MicrosoftOAuthClient,
    code: string,
    redirectUri: string
): Promise<MicrosoftAuthorization> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        scope: MICROSOFT_SCOPES.join(" ")
    });
    if (!token.refresh_token) {
        throw new Error(
            "Microsoft did not return a refresh token. The application needs the offline_access scope."
        );
    }
    const identity = await identify(token.access_token);
    return {
        accountId: identity.id,
        label: identity.mail ?? identity.userPrincipalName ?? identity.displayName ?? identity.id,
        // Only an address Microsoft returns as the account's mail is held. A
        // userPrincipalName looks like an address and frequently is not one.
        email: identity.mail ?? null,
        scope: token.scope ?? MICROSOFT_SCOPES.join(" "),
        credential: {
            refreshToken: token.refresh_token,
            accessToken: token.access_token,
            ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {})
        }
    };
}

/** The same round trip, for a sign-in that only has to name the account. */
export async function identifyMicrosoftAccount(
    client: MicrosoftOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        scope: MICROSOFT_SIGN_IN_SCOPES.join(" ")
    });
    const identity = await identify(token.access_token);
    return { accountId: identity.id };
}

async function identify(accessToken: string): Promise<z.infer<typeof meSchema>> {
    const response = await fetch(GRAPH_ME, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Microsoft would not say who authorized (${response.status})`);
    return meSchema.parse(await response.json());
}

/** Access tokens, kept until they are nearly expired. Keyed by the refresh token,
 *  so a re-linked account cannot be handed the previous one's. */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/** A currently-valid access token for a stored refresh token. */
export async function microsoftAccessToken(
    client: MicrosoftOAuthClient,
    refreshToken: string
): Promise<string> {
    const cached = accessTokens.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    let token: z.infer<typeof tokenSchema>;
    try {
        token = await postToken(client, {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: MICROSOFT_SCOPES.join(" ")
        });
    } catch (error) {
        throw new MicrosoftAuthExpiredError((error as Error).message);
    }
    const ttl = (token.expires_in ?? 3600) * 1000;
    accessTokens.set(refreshToken, { token: token.access_token, expiresAt: Date.now() + Math.max(0, ttl) });
    return token.access_token;
}

/** Forget a cached token, for when its refresh token is being discarded. */
export function forgetMicrosoftAccessToken(refreshToken: string): void {
    accessTokens.delete(refreshToken);
}

/** Raised when Microsoft has stopped accepting the stored refresh token - the
 *  account has to be linked again, and saying so is more use than a 401. */
export class MicrosoftAuthExpiredError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MicrosoftAuthExpiredError";
    }
}
