/**
 * The model a connected provider offers first, from the same catalog the AI
 * providers screen is built from. Used only to seed a repository's settings: an
 * operator naming another model is accepted, and an unknown one fails at
 * dispatch naming itself.
 */

import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";
import { catalogProviders } from "@/lib/integrations/provider-catalog-snapshot";

export function modelDefault(provider: string): string | undefined {
    const builtin = MODEL_INTEGRATIONS.find((entry) => entry.slug === provider)?.defaultModel;
    if (builtin) return builtin.slug;
    return catalogProviders().find((row) => row.slug === provider)?.defaultModel.slug || undefined;
}

/** The first connected provider's model, or "" when none is connected. */
export function firstModelOf(providers: readonly string[]): string {
    return providers.map((slug) => modelDefault(slug)).find(Boolean) ?? "";
}
