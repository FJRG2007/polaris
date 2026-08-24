/**
 * The round trip that turns "I say this account is mine" into "the provider says
 * this account is theirs".
 *
 * One shape per provider, behind one interface, so the link and callback routes
 * never learn which service they are talking to. What differs between them is
 * only where the operator's application lives and how a code is spent; what does
 * not differ is that Polaris writes a link because the provider answered, never
 * because a form was submitted.
 *
 * GitHub's callback path is the one it has always been. It is registered on the
 * app GitHub created for this instance, and an app cannot be told about a new one
 * without somebody editing it, so moving the path would break every deployment
 * that already connected.
 */

import { STEAM_PROVIDER } from "./steam";
import { connectionProven } from "./proven";
import { appBaseUrl } from "@/lib/domain-service";
import { connectionSignInAllowed } from "./store";
import type { ConnectionCredential } from "./store";
import { findConnectionProvider } from "@polaris/core";
import { getIntegrationState } from "@/lib/integration-service";
import {
    epicAuthorizeUrl,
    exchangeEpicCode,
    getEpicOAuthClient,
    identifyEpicAccount
} from "./epic";
import {
    authorizeGithubUser,
    getGithubUserAuth,
    githubLinkCallbackUrl
} from "@/lib/github-service";
import {
    DISCORD_REQUIRED_SCOPES,
    discordAuthorizeUrl,
    exchangeDiscordCode,
    getDiscordOAuthClient,
    identifyDiscordAccount
} from "./discord";
import {
    dropboxAuthorizeUrl,
    exchangeDropboxCode,
    getDropboxOAuthClient,
    identifyDropboxAccount
} from "./dropbox";
import {
    exchangeMinecraftCode,
    getMinecraftOAuthClient,
    identifyMinecraftAccount,
    minecraftAuthorizeUrl
} from "./minecraft";
import {
    exchangeMicrosoftCode,
    getMicrosoftOAuthClient,
    identifyMicrosoftAccount,
    microsoftAuthorizeUrl
} from "./microsoft";
import {
    exchangeGoogleCode,
    getGoogleOAuthClient,
    googleAuthorizeUrl,
    identifyGoogleAccount,
    verifyGoogleOAuthClient
} from "@/lib/google-calendar/service";

/** The operator's application, as a provider needs it to speak. */
export interface OAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** What the provider said, ready to be stored. */
export interface ConnectionAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly avatarUrl: string | null;
    /** The address on that account, set only when the provider says it has
     *  proved it. Null covers both "no address" and "one it has not proved" -
     *  neither is something to hold for anybody. */
    readonly email: string | null;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

/** Who authorized, and nothing else. What a sign-in needs and the most a sign-in
 *  is allowed to ask for. */
export interface ConnectionIdentity {
    readonly accountId: string;
}

/**
 * What the round trip is for. A sign-in asks for less than a link: it only has to
 * learn who is at the other end. `storage` asks for more than either - lasting
 * access to the files this application creates - and is kept separate so
 * somebody linking an account for one reason is never shown a consent screen
 * asking for the other.
 */
export type ConnectionFlow = "link" | "signin" | "storage";

interface ProviderOAuth {
    /** Where the provider returns somebody after they authorize. Registered on
     *  the operator's application, so it is built in one place. */
    callbackUrl(baseUrl: string): string;
    /** The operator's application, or null when this deployment has none. */
    client(): Promise<OAuthClient | null>;
    authorizeUrl(
        client: OAuthClient,
        redirectUri: string,
        state: string,
        flow: ConnectionFlow
    ): string;
    exchange(
        client: OAuthClient,
        code: string,
        redirectUri: string
    ): Promise<ConnectionAuthorization>;
    /** Spend a sign-in's code and report whose account it was. */
    identify(client: OAuthClient, code: string, redirectUri: string): Promise<ConnectionIdentity>;
    /** Ask the provider whether it would accept this application and this redirect
     *  URI, before an operator switches it on. What an operator would otherwise
     *  find out from somebody else's failed Connect button. Absent where the
     *  provider gives no answer that can be read without guessing. */
    verify?(client: OAuthClient, redirectUri: string): Promise<string | null>;
    /**
     * What a link has to have been granted to be worth anything.
     *
     * Declared so that widening a provider's consent screen is something the
     * people who already linked are told about, rather than something they find
     * out when a feature built on the new scope quietly returns nothing. Absent
     * where the scopes are not this deployment's to decide: a GitHub App's user
     * token carries the app's own permissions, and Steam has no scopes at all.
     */
    scopes?: readonly string[];
}

const ADAPTERS: Record<string, ProviderOAuth> = {
    github: {
        callbackUrl: githubLinkCallbackUrl,
        client: getGithubUserAuth,
        authorizeUrl: (client, redirectUri, state) => {
            // No scopes: a GitHub App's user token carries the permissions the app
            // was granted, and asking for more would only add a line to the consent
            // screen that means nothing.
            const url = new URL("https://github.com/login/oauth/authorize");
            url.searchParams.set("client_id", client.clientId);
            url.searchParams.set("redirect_uri", redirectUri);
            url.searchParams.set("state", state);
            return url.toString();
        },
        exchange: async (_client, code, redirectUri) => {
            const { account, token } = await authorizeGithubUser(code, redirectUri);
            return {
                accountId: String(account.id),
                label: account.login,
                avatarUrl: account.avatarUrl,
                email: account.email,
                scope: token.scope,
                credential: {
                    accessToken: token.accessToken,
                    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
                    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {})
                }
            };
        },
        // The same round trip: a GitHub App's user token is the only way to learn
        // which account authorized, and it is discarded the moment it has said so.
        identify: async (_client, code, redirectUri) => {
            const { account } = await authorizeGithubUser(code, redirectUri);
            return { accountId: String(account.id) };
        }
    },
    google: {
        callbackUrl: (baseUrl) => `${baseUrl}/api/connections/google/callback`,
        client: getGoogleOAuthClient,
        authorizeUrl: googleAuthorizeUrl,
        exchange: async (client, code, redirectUri) => {
            const granted = await exchangeGoogleCode(client, code, redirectUri);
            return {
                accountId: granted.accountId,
                label: granted.email || granted.accountId,
                avatarUrl: null,
                // Only an address Google has proved is worth holding for its
                // owner: what reads this next makes it one of their addresses
                // and sends account mail and codes to it.
                email: granted.emailVerified ? granted.email || null : null,
                scope: granted.scope,
                credential: { refreshToken: granted.refreshToken }
            };
        },
        identify: identifyGoogleAccount,
        verify: verifyGoogleOAuthClient
    },
    microsoft: {
        callbackUrl: (baseUrl) => `${baseUrl}/api/connections/microsoft/callback`,
        client: getMicrosoftOAuthClient,
        authorizeUrl: microsoftAuthorizeUrl,
        exchange: async (client, code, redirectUri) => {
            const granted = await exchangeMicrosoftCode(client, code, redirectUri);
            return { ...granted, avatarUrl: null };
        },
        identify: identifyMicrosoftAccount
    },
    epic: {
        callbackUrl: (baseUrl) => `${baseUrl}/api/connections/epic/callback`,
        client: getEpicOAuthClient,
        authorizeUrl: (client, redirectUri, state) => epicAuthorizeUrl(client, redirectUri, state),
        exchange: async (client, code, redirectUri) => {
            const granted = await exchangeEpicCode(client, code, redirectUri);
            // Epic vouches for no address, so nothing here becomes one of this
            // person's own.
            return { ...granted, avatarUrl: null, email: null };
        },
        identify: identifyEpicAccount
    },
    minecraft: {
        callbackUrl: (baseUrl) => `${baseUrl}/api/connections/minecraft/callback`,
        client: getMinecraftOAuthClient,
        authorizeUrl: (client, redirectUri, state) =>
            minecraftAuthorizeUrl(client, redirectUri, state),
        exchange: async (client, code, redirectUri) => {
            const granted = await exchangeMinecraftCode(client, code, redirectUri);
            // Nothing is kept: the username was the errand, and Polaris never acts
            // as somebody's Minecraft account afterwards.
            return { ...granted, avatarUrl: null, email: null, credential: {} };
        },
        identify: identifyMinecraftAccount
    },
    discord: {
        callbackUrl: (baseUrl) => `${baseUrl}/api/connections/discord/callback`,
        client: getDiscordOAuthClient,
        authorizeUrl: (client, redirectUri, state) =>
            discordAuthorizeUrl(client, redirectUri, state),
        // The address is already decided inside the exchange: Discord states on
        // the account whether it confirmed one, and only a confirmed address is
        // worth holding for its owner.
        exchange: exchangeDiscordCode,
        identify: identifyDiscordAccount,
        scopes: DISCORD_REQUIRED_SCOPES
    },
    dropbox: {
        callbackUrl: (baseUrl) => `${baseUrl}/api/connections/dropbox/callback`,
        client: getDropboxOAuthClient,
        authorizeUrl: dropboxAuthorizeUrl,
        exchange: async (client, code, redirectUri) => {
            const granted = await exchangeDropboxCode(client, code, redirectUri);
            return { ...granted, avatarUrl: null };
        },
        identify: identifyDropboxAccount
    }
};

/**
 * The services whose card on the Integrations screen configures an OAuth
 * application the operator registers: a client id, a secret, and a redirect URI
 * to paste into the vendor's console.
 *
 * Every adapter but GitHub, whose credentials are written by the App install
 * rather than typed into a dialog. Read off the table rather than listed again,
 * because the two lists that used to say this - the one deciding which cards get
 * the dialog and the one deciding which slugs the save action accepts - could
 * drift, and a provider missing from the second is one whose Save button refuses
 * every application with no way for the operator to tell why.
 */
export const OAUTH_APP_SLUGS: readonly string[] = Object.keys(ADAPTERS).filter(
    (slug) => slug !== "github"
);

/** Whether this provider can be authorized at all here. */
export function supportsOAuth(provider: string): boolean {
    return findConnectionProvider(provider) !== undefined && provider in ADAPTERS;
}

/**
 * Whether somebody can be sent to this provider right now.
 *
 * Three different answers, because three different things are missing. An OAuth
 * provider needs the application the operator registered - without it there is
 * nowhere to send anybody. It also needs one authorization to have completed here,
 * because credentials that parse are not a service that works and the provider is
 * the only thing that can say which it is; until then the trip is open to
 * administrators alone, who are the ones able to fix what it hits. Steam needs
 * neither: it proves an account over OpenID, so all that decides it is whether the
 * operator has switched the service on.
 */
export async function connectionLinkAvailable(
    provider: string,
    options?: { admin?: boolean }
): Promise<boolean> {
    if (provider === STEAM_PROVIDER)
        return (await getIntegrationState(STEAM_PROVIDER))?.enabled === true;
    if (!supportsOAuth(provider) || (await connectionOAuthClient(provider)) === null) return false;
    return options?.admin === true || (await connectionProven(provider));
}

/**
 * Whether this service may be offered as a way in, right now.
 *
 * Both halves: the operator allows it, and it has an application that has been
 * shown to work. A button that sends somebody to a consent screen refusing
 * everybody is worse than no button - they cannot tell a broken deployment from
 * an account of theirs that is not welcome here.
 */
export async function connectionSignInOffered(provider: string): Promise<boolean> {
    if (!supportsOAuth(provider)) return false;
    const [allowed, client] = await Promise.all([
        connectionSignInAllowed(provider),
        connectionOAuthClient(provider)
    ]);
    return allowed && client !== null && (await connectionProven(provider));
}

/** Steam is not in the adapter table - it has no code to exchange - so the one
 *  thing it shares with the others is named here. */
const STEAM_CALLBACK = (baseUrl: string): string => `${baseUrl}/api/connections/steam/callback`;

function adapter(provider: string): ProviderOAuth {
    const found = ADAPTERS[provider];
    if (!found) throw new Error(`Unknown connection provider: ${provider}`);
    return found;
}

/** Where the provider returns somebody, for the link route and for the operator
 *  to copy into the provider's console. */
export function connectionCallbackUrl(provider: string, baseUrl: string): string {
    if (provider === STEAM_PROVIDER) return STEAM_CALLBACK(baseUrl);
    return adapter(provider).callbackUrl(baseUrl);
}

/**
 * The one address every round trip runs on.
 *
 * Deliberately not the address the request arrived on. Behind the bundled proxy
 * that is the socket the server binds, and a provider does not merely fail to
 * match a redirect URI on it - Google refuses a raw IP address as a policy
 * violation, whatever is registered. It is also the address the Integrations
 * screen tells the operator to register, and a redirect URI that is not the
 * registered one is refused however it was arrived at. One function, so the URI
 * shown to be pasted and the URI actually sent cannot drift apart.
 */
export async function connectionFlowOrigin(): Promise<string> {
    return (await appBaseUrl()).replace(/\/+$/, "");
}

/** Where this provider returns somebody, on that address. */
export async function connectionRedirectUri(provider: string): Promise<string> {
    return connectionCallbackUrl(provider, await connectionFlowOrigin());
}

/**
 * Whether the provider will accept this application, before anybody is sent to it.
 *
 * Only the services that can answer the question have an answer: the rest return
 * null, which reads as "nothing said no". A verifier that guessed at another
 * provider's refusals would refuse working credentials, and an operator cannot
 * argue with a check that is wrong.
 */
export async function verifyConnectionOAuthApp(
    provider: string,
    client: OAuthClient,
    redirectUri: string
): Promise<string | null> {
    const verify = ADAPTERS[provider]?.verify;
    return verify ? verify(client, redirectUri) : null;
}

/** The operator's application for this provider, or null when there is none. */
export function connectionOAuthClient(provider: string): Promise<OAuthClient | null> {
    return adapter(provider).client();
}

export function connectionAuthorizeUrl(
    provider: string,
    client: OAuthClient,
    redirectUri: string,
    state: string,
    flow: ConnectionFlow = "link"
): string {
    return adapter(provider).authorizeUrl(client, redirectUri, state, flow);
}

export function exchangeConnectionCode(
    provider: string,
    client: OAuthClient,
    code: string,
    redirectUri: string
): Promise<ConnectionAuthorization> {
    return adapter(provider).exchange(client, code, redirectUri);
}

/** Whose account a sign-in's code belongs to. Nothing is stored from it: the
 *  link it matches already holds whatever Polaris needs to act as them. */
export function connectionIdentity(
    provider: string,
    client: OAuthClient,
    code: string,
    redirectUri: string
): Promise<ConnectionIdentity> {
    return adapter(provider).identify(client, code, redirectUri);
}

/**
 * Whether a link was granted everything this deployment now asks for.
 *
 * A provider's consent screen grows: `guilds` was added to Discord's after
 * people had already linked, and their grants carry the old, narrower scope. The
 * token still works, the account still shows on the screen, and the feature
 * built on the new scope returns nothing at all - which reads as the feature
 * being broken rather than as a consent nobody was asked for.
 *
 * Compared against what the provider actually granted rather than against what
 * was asked for at the time: a scope can be declined, and a declined scope is
 * the same problem as one never requested.
 *
 * True for anything this cannot answer - a provider with no declared scopes, one
 * that is not in the table - because the alternative is telling somebody to
 * re-link an account over a question that was never asked.
 */
export function linkScopesSatisfied(provider: string, granted: string): boolean {
    const required = ADAPTERS[provider]?.scopes;
    if (!required || required.length === 0) return true;
    const held = new Set(granted.split(/[\s,]+/).filter(Boolean));
    return required.every((scope) => held.has(scope));
}

/** The scopes a link is missing, for the sentence that asks somebody to
 *  authorize again. Empty when it is not missing any. */
export function missingLinkScopes(provider: string, granted: string): string[] {
    const required = ADAPTERS[provider]?.scopes ?? [];
    const held = new Set(granted.split(/[\s,]+/).filter(Boolean));
    return required.filter((scope) => !held.has(scope));
}
