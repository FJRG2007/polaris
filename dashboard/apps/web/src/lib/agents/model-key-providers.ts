/**
 * The providers a key can be added for, as the screens that add one need them.
 *
 * Built here rather than in either screen because both ask the same question:
 * the account adding its own key and the administrator adding the deployment's
 * are picking from one list, and a provider that appears on one screen and not
 * the other would be a provider somebody cannot bring a key for depending on who
 * they are.
 */

import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { PROVIDER_ALIASES } from "@/lib/integrations/provider-aliases";
import { MODEL_INTEGRATIONS, type FreeTier } from "@/lib/integrations/registry";
import { providerIsCheckable } from "@/lib/agents/provider-key-check";


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
}

export function modelProviderRows(): ProviderRow[] {
    return MODEL_INTEGRATIONS.map((entry) => ({
        slug: entry.slug,
        name: entry.name,
        aliases: PROVIDER_ALIASES[entry.slug] ?? [],
        apiKeyLabel: entry.apiKeyLabel ?? null,
        apiKeyHelp: entry.apiKeyHelp ?? null,
        createUrl: entry.setupLinks?.[0]?.url ?? null,
        isGateway: entry.slug === GATEWAY_SLUG,
        checkable: providerIsCheckable(entry.slug),
        freeTier: entry.freeTier ?? null
    }));
}

/** What a provider is called, for a sentence about a key that belongs to it. */
export { modelProviderName } from "@/lib/integrations/registry";
