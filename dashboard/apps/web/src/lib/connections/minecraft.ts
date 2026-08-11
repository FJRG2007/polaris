/**
 * Minecraft accounts, so a server can be opened to somebody by their Polaris name.
 *
 * A Minecraft server's door is a username: the access list here and the game's own
 * whitelist are both keyed by it, and getting one letter wrong is a player who
 * cannot join and nothing anywhere saying why. Linking the account is what makes
 * the name arrive spelled the way Mojang spells it.
 *
 * Proving it is four calls, not one. Microsoft signs somebody in; that token buys
 * an Xbox Live token; that buys an XSTS token for Minecraft's own relying party;
 * and that buys a Minecraft token, which is what the profile endpoint answers. It
 * reads like a lot because it is: Minecraft's account system was moved onto
 * Microsoft's and this is the seam.
 *
 * Its own Entra application rather than the one behind OneDrive, deliberately. The
 * scopes are different - this asks for Xbox and nothing else - and Microsoft gates
 * the Minecraft API behind an application it has approved, so the credentials that
 * reach it are not the ones storing somebody's backups.
 *
 * Two refusals are worth telling apart and both are ordinary: an account that does
 * not own the game has no profile, and a Game Pass account has none until it has
 * opened the launcher once.
 */

import { z } from "zod";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

export const MINECRAFT_PROVIDER = "minecraft";

/** The consumer tenant: a Minecraft account is a personal Microsoft account. */
const AUTHORIZE = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const TOKEN = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS = "https://xsts.auth.xboxlive.com/xsts/authorize";
const LOGIN_WITH_XBOX = "https://api.minecraftservices.com/authentication/login_with_xbox";
const PROFILE = "https://api.minecraftservices.com/minecraft/profile";

/** The one scope this needs. Without it the Xbox call refuses, and not in a way
 *  that names the missing scope. */
const SCOPES = ["XboxLive.signin"];

/** Four calls in a row, each of which can be slow. Bounded so a link that will
 *  not complete says so rather than hanging the browser on a redirect. */
const TIMEOUT_MS = 12_000;

export interface MinecraftOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

export async function getMinecraftOAuthClient(): Promise<MinecraftOAuthClient | null> {
    const state = await getIntegrationState(MINECRAFT_PROVIDER);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(MINECRAFT_PROVIDER);
    return clientSecret ? { clientId, clientSecret } : null;
}

export function minecraftAuthorizeUrl(client: MinecraftOAuthClient, redirectUri: string, state: string): string {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
}

const msTokenSchema = z.object({ access_token: z.string().min(1) });

const xblSchema = z.object({
    Token: z.string().min(1),
    DisplayClaims: z.object({ xui: z.array(z.object({ uhs: z.string().min(1) })).min(1) })
});

const minecraftTokenSchema = z.object({ access_token: z.string().min(1) });

const profileSchema = z.object({ id: z.string().min(1), name: z.string().min(1) });

export interface MinecraftAuthorization {
    /** The account's Minecraft UUID, which survives a rename and is what a link is
     *  held against. */
    readonly accountId: string;
    /** The username as Mojang spells it, which is what a server is told. */
    readonly label: string;
    readonly scope: string;
}

async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
    return fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
}

/** The Microsoft token, spent from the code the browser came back with. */
async function microsoftToken(
    client: MinecraftOAuthClient,
    code: string,
    redirectUri: string
): Promise<string> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            scope: SCOPES.join(" ")
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Microsoft refused the token request (${response.status})`);
    return msTokenSchema.parse(await response.json()).access_token;
}

/** The Xbox Live token and the user hash that has to travel with it. */
async function xboxToken(microsoftAccessToken: string): Promise<{ token: string; userHash: string }> {
    const response = await postJson(XBL, {
        Properties: {
            AuthMethod: "RPS",
            SiteName: "user.auth.xboxlive.com",
            RpsTicket: `d=${microsoftAccessToken}`
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT"
    });
    if (!response.ok) throw new Error(`Xbox Live refused the sign-in (${response.status})`);
    const parsed = xblSchema.parse(await response.json());
    return { token: parsed.Token, userHash: parsed.DisplayClaims.xui[0]?.uhs as string };
}

/** The XSTS token for Minecraft's own relying party. The refusals here are about
 *  the person rather than the request, so they are said in those terms. */
async function xstsToken(xboxLiveToken: string): Promise<string> {
    const response = await postJson(XSTS, {
        Properties: { SandboxId: "RETAIL", UserTokens: [xboxLiveToken] },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT"
    });
    if (response.status === 401) {
        const said = (await response.json().catch(() => null)) as { XErr?: number } | null;
        if (said?.XErr === 2148916238) {
            throw new Error("This Microsoft account is a child account and has to be added to a family first");
        }
        if (said?.XErr === 2148916233) {
            throw new Error("This Microsoft account has no Xbox profile yet. Sign in to Xbox once and try again.");
        }
        throw new Error("Xbox refused this account");
    }
    if (!response.ok) throw new Error(`Xbox refused the token request (${response.status})`);
    return xblSchema.parse(await response.json()).Token;
}

/** The Minecraft token, and then the profile it names. */
async function minecraftProfile(xsts: string, userHash: string): Promise<z.infer<typeof profileSchema>> {
    const login = await postJson(LOGIN_WITH_XBOX, { identityToken: `XBL3.0 x=${userHash};${xsts}` });
    if (!login.ok) throw new Error(`Minecraft refused the sign-in (${login.status})`);
    const token = minecraftTokenSchema.parse(await login.json()).access_token;

    const profile = await fetch(PROFILE, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // The ordinary answer for an account that has never played, which is not an
    // error worth showing as one.
    if (profile.status === 404) {
        throw new Error(
            "This account has no Minecraft profile. Somebody on Game Pass has to open the launcher once first."
        );
    }
    if (!profile.ok) throw new Error(`Minecraft refused the profile request (${profile.status})`);
    return profileSchema.parse(await profile.json());
}

/** Spend the code and read back which Minecraft account authorized. */
export async function exchangeMinecraftCode(
    client: MinecraftOAuthClient,
    code: string,
    redirectUri: string
): Promise<MinecraftAuthorization> {
    const microsoft = await microsoftToken(client, code, redirectUri);
    const xbox = await xboxToken(microsoft);
    const xsts = await xstsToken(xbox.token);
    const profile = await minecraftProfile(xsts, xbox.userHash);
    return { accountId: profile.id, label: profile.name, scope: SCOPES.join(" ") };
}

export async function identifyMinecraftAccount(
    client: MinecraftOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const { accountId } = await exchangeMinecraftCode(client, code, redirectUri);
    return { accountId };
}
