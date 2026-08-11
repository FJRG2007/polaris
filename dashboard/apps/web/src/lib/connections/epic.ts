/**
 * Epic Games accounts, for the players who own their game there rather than on
 * Steam.
 *
 * Ordinary OAuth, unlike Steam beside it: the operator registers a product in
 * Epic's developer portal and pastes its client id and secret, and Epic's token
 * endpoint takes those as basic auth. What comes back is an account id and,
 * with `basic_profile`, a display name - which is all that is wanted here. Epic
 * is asked for nothing else and the token is not kept for later: proving who
 * somebody is was the whole errand.
 *
 * Read defensively on purpose. Epic returns the account id on the token response
 * on some flows and only from `userInfo` on others, and the display name is
 * spelled differently in the two; a link is worth recording whichever of them
 * answered, so the id is taken from either and the name falls back to the id.
 */

import { z } from "zod";
import type { ConnectionCredential } from "./store";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

export const EPIC_PROVIDER = "epic";

const AUTHORIZE = "https://www.epicgames.com/id/authorize";
const TOKEN = "https://api.epicgames.dev/epic/oauth/v2/token";
const USER_INFO = "https://api.epicgames.dev/epic/oauth/v2/userInfo";

/** Enough to be told which account this is and what it calls itself. Epic offers
 *  a friends list too; a game server has no use for one. */
const SCOPES = ["basic_profile"];

/** How long to wait on Epic. A person is watching a redirect resolve. */
const TIMEOUT_MS = 10_000;

export interface EpicOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The product an operator registered, or null when this deployment has none. */
export async function getEpicOAuthClient(): Promise<EpicOAuthClient | null> {
    const state = await getIntegrationState(EPIC_PROVIDER);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(EPIC_PROVIDER);
    return clientSecret ? { clientId, clientSecret } : null;
}

export function epicAuthorizeUrl(client: EpicOAuthClient, redirectUri: string, state: string): string {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    account_id: z.string().optional(),
    displayName: z.string().optional()
});

const userInfoSchema = z.object({
    sub: z.string().min(1),
    preferred_username: z.string().optional(),
    display_name: z.string().optional(),
    displayName: z.string().optional()
});

export interface EpicAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

async function postToken(
    client: EpicOAuthClient,
    body: Record<string, string>
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            // Epic takes the product's credentials as basic auth on this endpoint.
            authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`
        },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Epic refused the token request (${response.status})`);
    return tokenSchema.parse(await response.json());
}

/** What the account calls itself, when the token did not already say. Null rather
 *  than a failure: a link is not worth refusing over a missing display name. */
async function readDisplayName(accessToken: string): Promise<{ id: string | null; name: string | null }> {
    const response = await fetch(USER_INFO, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    }).catch(() => null);
    if (!response?.ok) return { id: null, name: null };
    const parsed = userInfoSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { id: null, name: null };
    return {
        id: parsed.data.sub,
        name: parsed.data.displayName ?? parsed.data.display_name ?? parsed.data.preferred_username ?? null
    };
}

/** Spend the code and read back who authorized. */
export async function exchangeEpicCode(
    client: EpicOAuthClient,
    code: string,
    redirectUri: string
): Promise<EpicAuthorization> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
    });
    const profile = await readDisplayName(token.access_token);
    const accountId = token.account_id ?? profile.id;
    if (!accountId) throw new Error("Epic did not say which account authorized");
    return {
        accountId,
        label: token.displayName ?? profile.name ?? accountId,
        scope: token.scope ?? SCOPES.join(" "),
        // Nothing is done with an Epic account afterwards, so nothing is kept
        // that could be used to act as one.
        credential: {}
    };
}

/** Whose account a sign-in's code belongs to. */
export async function identifyEpicAccount(
    client: EpicOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const { accountId } = await exchangeEpicCode(client, code, redirectUri);
    return { accountId };
}
