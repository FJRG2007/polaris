/**
 * The application an operator registered for a service, read the one way.
 *
 * Every service whose card takes a client id and a secret stores them the same
 * way - the id in the Integration row's config because it is not a secret, the
 * secret encrypted beside it - and every one of them has to answer the same
 * question before anybody is sent to a consent screen: is this switched on, and
 * are both halves on file. Written once so the contract cannot drift between
 * providers, and so a service added later inherits it rather than copying it.
 *
 * Null covers all three ways there is nothing to send anybody to: switched off,
 * no client id, no secret. The screen that can fix any of them is the same one,
 * so none of them is worth telling apart here.
 */

import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

/** The operator's application: the pair a provider is spoken to with. */
export interface OAuthAppClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The application registered for this service, or null when this deployment has none. */
export async function oauthClientFor(slug: string): Promise<OAuthAppClient | null> {
    const state = await getIntegrationState(slug);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(slug);
    return clientSecret ? { clientId, clientSecret } : null;
}
