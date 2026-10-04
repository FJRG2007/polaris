/**
 * Checking an authorization request (RFC 6749 section 4.1.1, with PKCE and
 * resource indicators), before the consent screen is drawn and again when it is
 * answered.
 *
 * The order is what keeps this from being an open redirect: the client and its
 * redirect address are settled first, and until both are, nothing is sent
 * anywhere - the screen says what is wrong instead. Only once the address is one
 * the app registered may an error travel back to it (section 4.1.2.1).
 *
 * Run twice on purpose. The consent form posts back the request it was drawn
 * for, and that copy is the browser's to edit, so the approval re-checks every
 * field rather than trusting what the page was given.
 */

import { validChallenge } from "./pkce";
import { requestedScopes } from "./scopes";
import type { Permission } from "@polaris/core";
import { resolveClient, type OAuthClientRecord } from "./clients";
import {
    MAX_URI_LENGTH,
    canonicalResource,
    mcpResource,
    redirectMatches,
    sameResource,
    withParams
} from "./urls";

/** The parameters, as they arrived. */
export type AuthorizationParams = Readonly<Record<string, string | undefined>>;

/** A request that may be shown to the person. */
export interface AuthorizationRequest {
    readonly client: OAuthClientRecord;
    readonly redirectUri: string;
    readonly state: string | undefined;
    readonly codeChallenge: string;
    readonly resource: string;
    readonly scopes: Permission[];
}

/** Why the screen cannot even send the app an error: there is no address that
 *  is safe to send it to. */
export type UnsafeReason = "client" | "redirect";

export type AuthorizationCheck =
    | { readonly kind: "ok"; readonly request: AuthorizationRequest }
    | { readonly kind: "redirect"; readonly url: string }
    | { readonly kind: "unsafe"; readonly reason: UnsafeReason };

/** The longest `state` carried. It is the app's own value and goes back to it
 *  unchanged, so this only bounds what a link can make the page hold. */
const MAX_STATE = 1024;

/** Build the address an answer goes back to, with RFC 9207's `iss` on it. */
export function answerUrl(
    redirectUri: string,
    issuer: string,
    params: Record<string, string | undefined>
): string {
    return withParams(redirectUri, { ...params, iss: new URL(issuer).origin });
}

/**
 * Check one request. `resolve` is the client lookup, a parameter so a test can
 * hand one in without a database.
 */
export async function checkAuthorizationRequest(
    params: AuthorizationParams,
    origin: string,
    supportedScopes: readonly Permission[],
    resolve: (clientId: string) => Promise<OAuthClientRecord | null> = resolveClient
): Promise<AuthorizationCheck> {
    const clientId = params.client_id ?? "";
    const client = clientId && clientId.length <= MAX_URI_LENGTH ? await resolve(clientId) : null;
    if (!client) return { kind: "unsafe", reason: "client" };

    // OAuth 2.1 lets an app with exactly one registered address leave it out.
    // Not a loopback one: its port is chosen at run time, so the registered
    // spelling is not where the app is listening.
    let redirectUri = params.redirect_uri;
    if (!redirectUri && client.redirectUris.length === 1) {
        const only = client.redirectUris[0]!;
        if (!only.startsWith("http://")) redirectUri = only;
    }
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
        return { kind: "unsafe", reason: "redirect" };
    }

    const state = params.state;
    const back = (error: string, description: string): AuthorizationCheck => ({
        kind: "redirect",
        url: answerUrl(redirectUri, origin, {
            error,
            error_description: description,
            state: state && state.length <= MAX_STATE ? state : undefined
        })
    });

    if (state !== undefined && state.length > MAX_STATE)
        return back("invalid_request", "state is too long");
    if (params.response_type !== "code") {
        return back("unsupported_response_type", "Only the authorization code flow is supported");
    }
    if (!params.code_challenge || !validChallenge(params.code_challenge)) {
        return back("invalid_request", "PKCE is required: send a code_challenge made with S256");
    }
    if (params.code_challenge_method !== "S256") {
        return back("invalid_request", "code_challenge_method must be S256");
    }

    const expected = mcpResource(origin);
    let resource = expected;
    if (params.resource !== undefined) {
        if (!canonicalResource(params.resource) || !sameResource(params.resource, expected)) {
            return back("invalid_target", `This server issues tokens only for ${expected}`);
        }
        resource = canonicalResource(params.resource)!;
    }

    return {
        kind: "ok",
        request: {
            client,
            redirectUri,
            state,
            codeChallenge: params.code_challenge,
            resource,
            scopes: requestedScopes(params.scope, supportedScopes)
        }
    };
}

/** Read the parameters the page or the form was given. Repeated parameters are
 *  refused by taking none of them: RFC 6749 section 3.1 says a parameter must
 *  not appear twice, and picking one would let two parties read the same link
 *  differently. */
export function readParams(search: URLSearchParams): Record<string, string | undefined> {
    const params: Record<string, string | undefined> = {};
    for (const key of new Set(search.keys())) {
        const values = search.getAll(key);
        params[key] = values.length === 1 ? values[0] : undefined;
    }
    return params;
}
