/**
 * The providers a key can be added for, as the screens that add one need them.
 *
 * Built here rather than in either screen because both ask the same question:
 * the account adding its own key and the administrator adding the deployment's
 * are picking from one list, and a provider that appears on one screen and not
 * the other would be a provider somebody cannot bring a key for depending on who
 * they are.
 *
 * Server-only. The catalogue runs to thousands of providers, so no screen is
 * handed the whole of it: the picker pages through `searchKeyProvidersAction`
 * and the keys table gets rows only for the providers its keys belong to.
 */

import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { PROVIDER_ALIASES } from "@/lib/integrations/provider-aliases";
import { MODEL_INTEGRATIONS, type FreeTier } from "@/lib/integrations/registry";
import { providerIsCheckable } from "@/lib/agents/provider-key-check";
import { catalogProvider } from "@/lib/integrations/provider-catalog-snapshot";

/** One provider, as the dialog and the table need it. */
export interface ProviderRow {
    slug: string;
    name: string;
    /** Extra words somebody might type instead of the name. */
    aliases: string[];
    /** The provider's own name for its key; null is the dialog's "API key". */
    apiKeyLabel: string | null;
    apiKeyHelp: string | null;
    createUrl: string | null;
    /** The gateway is not a provider: it needs an endpoint and a model as well as
     *  a token, and the token is frequently not needed at all. */
    isGateway: boolean;
    /** Whether Polaris can ask this provider whether a key is good before storing
     *  it, so the dialog can say which of the two it is doing. */
    checkable: boolean;
    /** Whether a key can be had here without paying, and on what terms. Null for
     *  a provider that bills from the first token. */
    freeTier: FreeTier | null;
    /** The logo to draw when the slug is not one (an agent's sign-in): the
     *  agent's own id. */
    logo?: string;
}

/**
 * One provider as a row: the hand-written registry entry when there is one (it
 * carries the provider's own words for its key), else the stored catalogue's.
 * `fallback` names a provider the snapshot has not read yet (a hit straight
 * from the store), so a fresh custom provider still shows its name.
 */
export function providerRow(
    slug: string,
    fallback?: { name: string; freeTier: FreeTier | null }
): ProviderRow {
    const builtin = MODEL_INTEGRATIONS.find((entry) => entry.slug === slug);
    const stored = builtin ? undefined : catalogProvider(slug);
    return {
        slug,
        name: builtin?.name ?? stored?.name ?? fallback?.name ?? slug,
        aliases: PROVIDER_ALIASES[slug] ?? [],
        apiKeyLabel: builtin?.apiKeyLabel ?? null,
        apiKeyHelp: builtin?.apiKeyHelp ?? null,
        createUrl: builtin?.setupLinks?.[0]?.url ?? stored?.keyUrl ?? null,
        isGateway: slug === GATEWAY_SLUG,
        checkable: providerIsCheckable(slug),
        freeTier: builtin?.freeTier ?? stored?.free ?? fallback?.freeTier ?? null
    };
}

/** Rows for the providers some keys belong to, each once, in first-seen order. */
export function providerRowsFor(slugs: readonly string[]): ProviderRow[] {
    return [...new Set(slugs)].slice(0, 500).map((slug) => providerRow(slug));
}

/** What a provider is called, for a sentence about a key that belongs to it. */
export function modelProviderName(slug: string): string {
    return (
        MODEL_INTEGRATIONS.find((entry) => entry.slug === slug)?.name ??
        catalogProvider(slug)?.name ??
        slug
    );
}
