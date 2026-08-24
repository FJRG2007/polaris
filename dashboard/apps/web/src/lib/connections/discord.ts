/**
 * Discord accounts, for the servers and screens that know a person by one.
 *
 * FiveM is the reason this exists: its door is keyed by a Discord account id, the
 * way ARK's is keyed by a Steam id, so adding somebody to a server meant asking
 * them for an eighteen-digit number over chat and pasting it correctly. Whoever
 * has linked their account here has already handed that number over in a way that
 * cannot be mistyped.
 *
 * Ordinary OAuth: the operator registers an application in Discord's developer
 * portal and pastes its client id and secret. `identify` is the only scope asked
 * for - it returns the account id and the name, and deliberately not the address,
 * because an address is not what a game server's door is closed by and a consent
 * screen should ask for what the errand needs. The token is spent and dropped:
 * proving who somebody is was the whole of it, and nothing here is ever able to
 * post as them or read what they are in.
 *
 * The name is read twice over because Discord has two account eras. A migrated
 * account has a unique `username` and shows a `global_name` on top of it; an old
 * one has neither and is spelled `name#1234`. Both have to end up as something a
 * person recognises beside their own link.
 */

import { z } from "zod";
import { refusalMessage } from "./refusal";
import type { ConnectionCredential } from "./store";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

export const DISCORD_PROVIDER = "discord";

const AUTHORIZE = "https://discord.com/oauth2/authorize";
const TOKEN = "https://discord.com/api/oauth2/token";
/** Pinned to a version, unlike the token endpoint beside it: this is the call
 *  whose response shape is read field by field, so the version it was written
 *  against is the version it should keep asking. */
const CURRENT_USER = "https://discord.com/api/v10/users/@me";
const AVATAR_CDN = "https://cdn.discordapp.com/avatars";

/**
 * Who the account is, and nothing else.
 *
 * Not `email`: no screen here needs the address on a Discord account, and asking
 * for one would put a line on the consent screen that buys this deployment
 * nothing. Not `guilds` either - which servers somebody is in is their business,
 * and Polaris has no use for the list.
 */
const SCOPES = ["identify"];

/** How long to wait on Discord. Somebody is watching a redirect resolve. */
const TIMEOUT_MS = 10_000;

/** The avatar size to ask the CDN for. A power of two, as Discord requires, and
 *  the largest any screen here draws one at. */
const AVATAR_SIZE = 128;

export interface DiscordOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The application an operator registered, or null when this deployment has none. */
export async function getDiscordOAuthClient(): Promise<DiscordOAuthClient | null> {
    const state = await getIntegrationState(DISCORD_PROVIDER);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(DISCORD_PROVIDER);
    return clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Where to send somebody to authorize.
 *
 * `prompt=consent` on purpose. Discord's default skips the screen entirely for an
 * account that has authorized this application before, which is convenient and
 * wrong here: the two things this round trip can end in are linking an account
 * and opening a session, and somebody signing in should see whose account is
 * about to be used rather than be silently bounced back as whoever the browser
 * happened to be logged in as.
 */
export function discordAuthorizeUrl(client: DiscordOAuthClient, redirectUri: string, state: string): string {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "consent");
    return url.toString();
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional()
});

/** Only the fields this reads. Discord returns a great many more and none of them
 *  is wanted; an open shape here would be an invitation to start using one. */
const userSchema = z.object({
    id: z.string().min(1),
    username: z.string().optional(),
    global_name: z.string().nullish(),
    discriminator: z.string().optional(),
    avatar: z.string().nullish()
});

export interface DiscordAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly avatarUrl: string | null;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

/**
 * What to call this account.
 *
 * `global_name` is the display name Discord itself shows and the one somebody
 * will recognise. Failing that the handle, which on a pre-2023 account is only
 * unique with its four digits after it - `#0` is what a migrated account carries
 * there and is not part of anybody's name.
 */
function displayName(user: z.infer<typeof userSchema>): string {
    const global = user.global_name?.trim();
    if (global) return global;
    const username = user.username?.trim();
    if (!username) return user.id;
    const tag = user.discriminator?.trim();
    return tag && tag !== "0" ? `${username}#${tag}` : username;
}

/** The account's picture on Discord's CDN, or null when it has none and Discord
 *  is drawing a default. Animated hashes are marked with an `a_` prefix and are
 *  the one case that is not a png. */
function avatarUrl(user: z.infer<typeof userSchema>): string | null {
    const hash = user.avatar?.trim();
    if (!hash) return null;
    const animated = hash.startsWith("a_");
    const url = new URL(`${AVATAR_CDN}/${user.id}/${hash}.${animated ? "webp" : "png"}`);
    url.searchParams.set("size", String(AVATAR_SIZE));
    if (animated) url.searchParams.set("animated", "true");
    return url.toString();
}

/** Spend the code. Discord takes the application's credentials in the form body
 *  on this endpoint, which is what its own examples do. */
async function postToken(
    client: DiscordOAuthClient,
    code: string,
    redirectUri: string
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // Discord's own reason is the whole value of this failing: a redirect URI
    // that is not registered, a secret that was reset, and an application whose
    // client id belongs to a different one are three different fixes behind one
    // status code, and the operator is not the person standing at the redirect.
    if (!response.ok) throw new Error(await refusalMessage(response, "Discord refused the token request"));
    return tokenSchema.parse(await response.json());
}

/** Who the token belongs to. */
async function readUser(accessToken: string): Promise<z.infer<typeof userSchema>> {
    const response = await fetch(CURRENT_USER, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(await refusalMessage(response, "Discord would not say which account authorized"));
    return userSchema.parse(await response.json());
}

/** Spend the code and read back who authorized. */
export async function exchangeDiscordCode(
    client: DiscordOAuthClient,
    code: string,
    redirectUri: string
): Promise<DiscordAuthorization> {
    const token = await postToken(client, code, redirectUri);
    const user = await readUser(token.access_token);
    return {
        accountId: user.id,
        label: displayName(user),
        avatarUrl: avatarUrl(user),
        scope: token.scope ?? SCOPES.join(" "),
        // Nothing is kept. Polaris never acts as somebody's Discord account, so
        // holding a token that could would be storing a way to do something it
        // has no reason to do.
        credential: {}
    };
}

/** Whose account a sign-in's code belongs to. */
export async function identifyDiscordAccount(
    client: DiscordOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const { accountId } = await exchangeDiscordCode(client, code, redirectUri);
    return { accountId };
}
