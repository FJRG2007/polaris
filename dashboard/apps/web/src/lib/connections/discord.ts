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
 * portal and pastes its client id and secret. Three scopes are asked for -
 * `identify` for the account and its name, `email` for the address, and `guilds`
 * for the list of servers the account is in - because the servers and the address
 * are wanted for what is built on top of this next.
 *
 * That last one is why the token is kept, where Steam, Epic and Minecraft keep
 * nothing. A server list is not a fact that stays true: somebody joins one an
 * hour after linking, and a copy taken at link time is wrong by the time anything
 * reads it. So the grant is stored encrypted and the list is asked for when it is
 * wanted. Discord's access tokens last a week, so the refresh token is stored
 * with it and spent on the way past - a token nothing refreshed would be dead
 * seven days after the link and the failure would look like a revoked account.
 *
 * `guilds` reads which servers somebody is in, and nothing inside them: not the
 * channels, not the messages, not who else is there. Polaris still cannot post as
 * anybody.
 *
 * The name is read twice over because Discord has two account eras. A migrated
 * account has a unique `username` and shows a `global_name` on top of it; an old
 * one has neither and is spelled `name#1234`. Both have to end up as something a
 * person recognises beside their own link.
 */

import { z } from "zod";
import { refusalMessage } from "./refusal";
import { oauthClientFor } from "./oauth-app";
import type { ConnectionCredential } from "./store";

export const DISCORD_PROVIDER = "discord";

const AUTHORIZE = "https://discord.com/oauth2/authorize";
const TOKEN = "https://discord.com/api/oauth2/token";
/** Pinned to a version, unlike the token endpoint beside it: this is the call
 *  whose response shape is read field by field, so the version it was written
 *  against is the version it should keep asking. */
const CURRENT_USER = "https://discord.com/api/v10/users/@me";
const AVATAR_CDN = "https://cdn.discordapp.com/avatars";
const GUILD_ICON_CDN = "https://cdn.discordapp.com/icons";

/**
 * What the consent screen asks for.
 *
 * `guilds` is the widest of the three and is still only a list of servers: the
 * read it allows is `/users/@me/guilds`, which returns the id, the name and the
 * icon of each, and reaches nothing inside any of them. `guilds.members.read`,
 * which would return somebody's nickname and roles in a server, is deliberately
 * not here - it is a larger permission and nothing asks for it yet.
 *
 * Adding to this list is a change every person who has already linked has to
 * consent to again. `REQUIRED_SCOPES` below is what makes that visible to them
 * rather than surfacing later as an empty server list.
 */
const SCOPES = ["identify", "email", "guilds"];

/** The scopes a link has to carry to be worth anything, so one granted before
 *  this list grew can be spotted and its owner asked to authorize again. */
export const DISCORD_REQUIRED_SCOPES: readonly string[] = SCOPES;

/** Where the servers an account is in are read from. */
const CURRENT_GUILDS = "https://discord.com/api/v10/users/@me/guilds";

/** Spent this far before expiry rather than exactly at it, so a call that takes
 *  a moment is not signed with a token that dies mid-flight. */
const REFRESH_MARGIN_MS = 60_000;

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
export function getDiscordOAuthClient(): Promise<DiscordOAuthClient | null> {
    return oauthClientFor(DISCORD_PROVIDER);
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
export function discordAuthorizeUrl(
    client: DiscordOAuthClient,
    redirectUri: string,
    state: string
): string {
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
    avatar: z.string().nullish(),
    email: z.string().nullish(),
    /** Discord's own word on whether anybody proved they read that address. */
    verified: z.boolean().nullish()
});

/** One server, as `/users/@me/guilds` returns it. Only the fields worth having:
 *  the id is the identity, the rest is what a person would recognise it by. */
const guildSchema = z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    icon: z.string().nullish(),
    owner: z.boolean().nullish()
});

export interface DiscordGuild {
    readonly id: string;
    readonly name: string;
    readonly iconUrl: string | null;
    readonly owner: boolean;
}

export interface DiscordAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly avatarUrl: string | null;
    /** The address on the account, when Discord says it confirmed one. Null
     *  otherwise: an unproved address is where a second-factor code would go. */
    readonly email: string | null;
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
 *  the one case that is not a png: an animated asset is served as a gif, which is
 *  the extension Discord documents for one. */
function avatarUrl(user: z.infer<typeof userSchema>): string | null {
    const hash = user.avatar?.trim();
    if (!hash) return null;
    const url = new URL(
        `${AVATAR_CDN}/${user.id}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}`
    );
    url.searchParams.set("size", String(AVATAR_SIZE));
    return url.toString();
}

/** Spend a grant. Discord takes the application's credentials in the form body
 *  on this endpoint, which is what its own examples do. */
async function postToken(
    client: DiscordOAuthClient,
    grant: Record<string, string>
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            ...grant
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // Discord's own reason is the whole value of this failing: a redirect URI
    // that is not registered, a secret that was reset, and an application whose
    // client id belongs to a different one are three different fixes behind one
    // status code, and the operator is not the person standing at the redirect.
    if (!response.ok)
        throw new Error(await refusalMessage(response, "Discord refused the token request"));
    return tokenSchema.parse(await response.json());
}

/** Who the token belongs to. */
async function readUser(accessToken: string): Promise<z.infer<typeof userSchema>> {
    const response = await fetch(CURRENT_USER, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok)
        throw new Error(
            await refusalMessage(response, "Discord would not say which account authorized")
        );
    return userSchema.parse(await response.json());
}

/** What a token response is worth storing, as the credential column holds it. */
function credentialFrom(token: z.infer<typeof tokenSchema>): ConnectionCredential {
    return {
        accessToken: token.access_token,
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
        // Absolute rather than the seconds Discord counts in, because what reads
        // this next is comparing it against the clock, not against the moment
        // this response happened to arrive.
        ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {})
    };
}

/** Spend the code and read back who authorized. */
export async function exchangeDiscordCode(
    client: DiscordOAuthClient,
    code: string,
    redirectUri: string
): Promise<DiscordAuthorization> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
    });
    const user = await readUser(token.access_token);
    return {
        accountId: user.id,
        label: displayName(user),
        avatarUrl: avatarUrl(user),
        // Only an address Discord states it confirmed. What reads this next makes
        // it one of this person's own addresses, and an unproved one is where a
        // second-factor code would be sent.
        email: user.verified === true && user.email ? user.email : null,
        scope: token.scope ?? SCOPES.join(" "),
        // Kept, unlike the other game identities: the server list is asked for
        // when it is wanted rather than copied at link time, and that needs a
        // grant that is still good. Encrypted by the store before it is written.
        credential: credentialFrom(token)
    };
}

/**
 * An access token for this link that is good right now.
 *
 * Refreshes past the margin and hands the replacement back to be written, so the
 * next read does not repeat the round trip. Null when there is nothing to refresh
 * with - a link made before the token was kept, or a grant its owner withdrew -
 * which is a link that has to be made again rather than an error worth throwing
 * from a list nobody asked to fail.
 */
export async function discordAccessToken(
    client: DiscordOAuthClient,
    credential: ConnectionCredential
): Promise<{ accessToken: string; refreshed: ConnectionCredential | null } | null> {
    const fresh = credential.expiresAt === undefined || credential.expiresAt - REFRESH_MARGIN_MS > Date.now();
    if (credential.accessToken && fresh) return { accessToken: credential.accessToken, refreshed: null };
    if (!credential.refreshToken) return null;

    const token = await postToken(client, {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken
    });
    return { accessToken: token.access_token, refreshed: credentialFrom(token) };
}

/**
 * The servers this account is in.
 *
 * Asked for rather than remembered: somebody joins a server an hour after
 * linking, and a copy taken at link time would be answering about the past. The
 * icon is resolved here so nothing downstream has to know Discord's CDN.
 */
export async function readDiscordGuilds(accessToken: string): Promise<DiscordGuild[]> {
    const response = await fetch(CURRENT_GUILDS, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(await refusalMessage(response, "Discord would not list the servers"));
    const parsed = z.array(guildSchema).safeParse(await response.json());
    if (!parsed.success) throw new Error("Discord's server list was not the shape it documents");
    return parsed.data.map((guild) => ({
        id: guild.id,
        name: guild.name?.trim() || guild.id,
        iconUrl: guild.icon ? `${GUILD_ICON_CDN}/${guild.id}/${guild.icon}.png?size=${AVATAR_SIZE}` : null,
        owner: guild.owner === true
    }));
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
