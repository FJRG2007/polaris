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
import { refusalMessage } from "./refusal";
import { oauthClientFor } from "./oauth-app";
import type { ConnectionCredential } from "./store";

export const MICROSOFT_PROVIDER = "microsoft";

const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

/** Read and write the files this application creates, and learn who authorized.
 *  `Files.ReadWrite` is the least privilege that can store a backup. */
export const MICROSOFT_SCOPES = ["openid", "email", "offline_access", "Files.ReadWrite"];

/** Naming the account is all a sign-in needs. */
export const MICROSOFT_SIGN_IN_SCOPES = ["openid", "email"];

/**
 * What linking an Outlook mailbox asks for.
 *
 * Microsoft splits reading from sending, so both are named, and `offline_access`
 * is what makes the authorization outlast the hour its first token lives. These
 * are Outlook's own scopes rather than Graph's: they are the ones its IMAP and
 * SMTP endpoints accept, and a Graph token is refused there.
 */
export const MICROSOFT_MAIL_SCOPES = [
    "openid",
    "email",
    "offline_access",
    "https://outlook.office.com/IMAP.AccessAsUser.All",
    "https://outlook.office.com/SMTP.Send"
];

/**
 * What linking a calendar to the Calendar app asks for: Graph's read and write
 * access to the account's calendars, on its own consent screen for the same
 * reason mail has one. Graph and Outlook's mail protocols are different audiences,
 * so the access token Calendar spends is minted for these scopes alone.
 */
export const MICROSOFT_CALENDAR_SCOPES = [
    "openid",
    "email",
    "offline_access",
    "https://graph.microsoft.com/Calendars.ReadWrite"
];

export interface MicrosoftOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The application an operator connected, or null when this deployment has none. */
export function getMicrosoftOAuthClient(): Promise<MicrosoftOAuthClient | null> {
    return oauthClientFor(MICROSOFT_PROVIDER);
}

export function microsoftAuthorizeUrl(
    client: MicrosoftOAuthClient,
    redirectUri: string,
    state: string,
    flow: "link" | "signin" | "storage" | "mail" | "calendar" | "office" = "link",
    /** Which account to open on - see `googleAuthorizeUrl`. */
    loginHint?: string
): string {
    const signIn = flow === "signin";
    const scopes = signIn
        ? MICROSOFT_SIGN_IN_SCOPES
        : flow === "mail"
          ? MICROSOFT_MAIL_SCOPES
          : flow === "calendar"
            ? MICROSOFT_CALENDAR_SCOPES
            : MICROSOFT_SCOPES;
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    // An account chooser for a sign-in; a fresh consent when lasting access to
    // somebody's files is being asked for, so it is never granted silently.
    url.searchParams.set("prompt", signIn ? "select_account" : "consent");
    url.searchParams.set("state", state);
    if (loginHint) url.searchParams.set("login_hint", loginHint);
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
    if (response.status === 400 || response.status === 401) {
        throw new MicrosoftAuthExpiredError(
            await refusalMessage(response, "Microsoft refused the token request")
        );
    }
    if (!response.ok) {
        throw new Error(await refusalMessage(response, "Microsoft refused the token request"));
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
    if (!response.ok)
        throw new Error(await refusalMessage(response, "Microsoft would not say who authorized"));
    return meSchema.parse(await response.json());
}

/** Access tokens, kept until they are nearly expired. Keyed by the refresh token,
 *  so a re-linked account cannot be handed the previous one's. */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/** A currently-valid access token for a stored refresh token. */
export async function microsoftAccessToken(
    client: MicrosoftOAuthClient,
    refreshToken: string,
    scopes: readonly string[] = MICROSOFT_SCOPES
): Promise<string> {
    // Keyed by the scopes as well as the token: the same account can hold one
    // authorization for files and another for mail, and handing a file token to
    // an IMAP server is a refusal nobody could read.
    const key = `${refreshToken} ${scopes.join(" ")}`;
    const cached = accessTokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const token = await postToken(client, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: scopes.join(" ")
    });
    const ttl = (token.expires_in ?? 3600) * 1000;
    accessTokens.set(key, {
        token: token.access_token,
        expiresAt: Date.now() + Math.max(0, ttl)
    });
    return token.access_token;
}

/** Forget every cached token minted from this refresh token, for when it is
 *  being discarded. One refresh token can have several entries here, one per
 *  set of scopes it has been spent for. */
export function forgetMicrosoftAccessToken(refreshToken: string): void {
    for (const key of accessTokens.keys()) {
        if (key === refreshToken || key.startsWith(`${refreshToken} `)) accessTokens.delete(key);
    }
}

/** Raised when Microsoft's token endpoint refuses the grant (a 400 or 401) -
 *  the account has to be linked again, and saying so is more use than a 401.
 *  A network failure or a 5xx is not this: it is thrown as it came, so the
 *  caller retries rather than asking anybody to reconnect. */
export class MicrosoftAuthExpiredError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MicrosoftAuthExpiredError";
    }
}
