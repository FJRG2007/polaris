/**
 * How an app sends somebody to Connected accounts and gets them back: `?provider=`
 * marks the service it sent them for, and `?return=` names its own screen, which
 * the list offers to go back to and the link trip carries through the provider.
 *
 * Pure, so the screens that link here and the link flow share one spelling.
 */

export const CONNECTIONS_HUB = "/account/connections";

/** The hub's sections for Polaris's own apps, which `?provider=` points at. */
export const TASK_TRACKERS_SECTION = "task-trackers";
export const AI_KEYS_SECTION = "ai-keys";

/** The query parameter an app names its own screen in, to be sent back to it. */
export const RETURN_PARAM = "return";

export function connectionsHref(provider?: string | null, returnTo?: string | null): string {
    return withHubParams(CONNECTIONS_HUB, provider, returnTo);
}

/** The same hub for what one organization owns, in that organization's screens. */
export function orgConnectionsHref(
    slug: string,
    provider?: string | null,
    returnTo?: string | null
): string {
    return withHubParams(
        `/account/organizations/${encodeURIComponent(slug)}/connections`,
        provider,
        returnTo
    );
}

function withHubParams(base: string, provider?: string | null, returnTo?: string | null): string {
    const params = new URLSearchParams();
    if (provider) params.set("provider", provider);
    if (returnTo) params.set(RETURN_PARAM, returnTo);
    const search = params.toString();
    return search ? `${base}?${search}` : base;
}
