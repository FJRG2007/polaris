/**
 * The AI provider catalogue as the synchronous readers see it.
 *
 * The catalogue lives in the database (`provider-catalog.ts`): seeded from the
 * table in `model-providers.ts`, widened from the public model index and added
 * to by operators. Three readers need it on paths that cannot wait on a query -
 * which provider a model slug needs a key for, the variable a run reads it from,
 * the endpoint a pasted key is checked at - so the server keeps the last rows it
 * read here, and every reader asks this module rather than a list of its own.
 *
 * It starts as the seed table, so a process that has not reached the database
 * yet (a test, the first request of a boot) still knows every seeded provider,
 * and it is replaced whole whenever the store is read. Server-only in practice:
 * nothing here ships a list to a browser, which receives pages of it from
 * `searchProviderCatalog` instead.
 */

import type { IntegrationCatalogEntry } from "@/lib/integrations/registry";
import {
    describe,
    MODEL_PROVIDER_SEEDS,
    type ModelProviderSeed
} from "@/lib/integrations/model-providers";

/** Where a row came from, which decides who may rewrite it. */
export type CatalogSource = "seed" | "index" | "custom";

/** One provider, as every reader of the catalogue needs it. */
export interface CatalogProvider extends ModelProviderSeed {
    source: CatalogSource;
}

/** The seed table, as catalogue rows. */
export function seedCatalogProviders(): CatalogProvider[] {
    return MODEL_PROVIDER_SEEDS.map((seed) => ({ ...seed, source: "seed" as const }));
}

let current: readonly CatalogProvider[] = seedCatalogProviders();
let bySlug = new Map(current.map((row) => [row.slug, row]));
let revision = 0;

/** Every provider the store held when it was last read. */
export function catalogProviders(): readonly CatalogProvider[] {
    return current;
}

/** One provider by slug. */
export function catalogProvider(slug: string): CatalogProvider | undefined {
    return bySlug.get(slug);
}

/** Bumped on every replacement, so a reader that derives a list can cache it. */
export function catalogRevision(): number {
    return revision;
}

/**
 * Replace the catalogue with what the store holds. A seed row the store lacks
 * (a store that could not be written) is kept, so the seeded providers never
 * disappear from a running process because a write failed.
 */
export function replaceCatalogProviders(rows: readonly CatalogProvider[]): void {
    const slugs = new Set(rows.map((row) => row.slug));
    const kept = seedCatalogProviders().filter((seed) => !slugs.has(seed.slug));
    current = [...rows, ...kept];
    bySlug = new Map(current.map((row) => [row.slug, row]));
    revision += 1;
}

/** One provider as a marketplace entry. */
export function catalogIntegration(row: ModelProviderSeed): IntegrationCatalogEntry {
    return {
        slug: row.slug,
        name: row.name,
        category: "Models",
        summary: row.summary,
        description: describe(row),
        docsUrl: row.docsUrl,
        setupLinks: row.keyUrl ? [{ label: "Create an API key", url: row.keyUrl }] : undefined, // i18n-ignore
        requiresApiKey: true,
        defaultModel: row.defaultModel,
        freeTier: row.free
    };
}

/** The endpoint a chat is sent to for a provider reached by its endpoint (one
 *  outside the index, or an index provider whose `api` the refresh recorded). */
export function catalogEndpoint(
    slug: string
): { api: "openai" | "anthropic"; baseUrl: string } | null {
    const row = bySlug.get(slug);
    if (!row?.baseUrl) return null;
    return { api: row.wire === "anthropic" ? "anthropic" : "openai", baseUrl: row.baseUrl };
}
