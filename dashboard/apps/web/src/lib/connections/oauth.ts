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

import type { ConnectionCredential } from "./store";
import { findConnectionProvider } from "@polaris/core";
import { authorizeGithubUser, getGithubUserAuth, githubLinkCallbackUrl } from "@/lib/github-service";
import {
    exchangeGoogleCode,
    getGoogleOAuthClient,
    googleAuthorizeUrl,
    identifyGoogleAccount
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
    /** The address on that account, when the provider vouches for one. */
    readonly email: string | null;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

/** Who authorized, and nothing else. What a sign-in needs and the most a sign-in
 *  is allowed to ask for. */
export interface ConnectionIdentity {
    readonly accountId: string;
}

/** What the round trip is for. A sign-in asks for less than a link: it only has
 *  to learn who is at the other end, and asking for more would put a permission
 *  on the consent screen that nothing would use. */
export type ConnectionFlow = "link" | "signin";

interface ProviderOAuth {
    /** Where the provider returns somebody after they authorize. Registered on
     *  the operator's application, so it is built in one place. */
    callbackUrl(baseUrl: string): string;
    /** The operator's application, or null when this deployment has none. */
    client(): Promise<OAuthClient | null>;
    authorizeUrl(client: OAuthClient, redirectUri: string, state: string, flow: ConnectionFlow): string;
    exchange(client: OAuthClient, code: string, redirectUri: string): Promise<ConnectionAuthorization>;
    /** Spend a sign-in's code and report whose account it was. */
    identify(client: OAuthClient, code: string, redirectUri: string): Promise<ConnectionIdentity>;
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
                email: granted.email || null,
                scope: granted.scope,
                credential: { refreshToken: granted.refreshToken }
            };
        },
        identify: identifyGoogleAccount
    }
};

/** Whether this provider can be authorized at all here. */
export function supportsOAuth(provider: string): boolean {
    return findConnectionProvider(provider) !== undefined && provider in ADAPTERS;
}

function adapter(provider: string): ProviderOAuth {
    const found = ADAPTERS[provider];
    if (!found) throw new Error(`Unknown connection provider: ${provider}`);
    return found;
}

/** Where the provider returns somebody, for the link route and for the operator
 *  to copy into the provider's console. */
export function connectionCallbackUrl(provider: string, baseUrl: string): string {
    return adapter(provider).callbackUrl(baseUrl);
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
