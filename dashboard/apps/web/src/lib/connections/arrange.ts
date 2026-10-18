/**
 * How Connected accounts orders and narrows its list once there are more services
 * than fit on one screen: a search over the name and the line under it, one
 * section at a time, and the services somebody already uses ahead of the ones
 * they have never touched.
 *
 * Pure, so the screen and its tests share it.
 */

import { connectionSections, type ConnectionCategory } from "@polaris/core";

export interface ArrangeableProvider {
    slug: string;
    name: string;
    summary?: string;
    category: ConnectionCategory;
    accounts: readonly unknown[];
}

export interface ArrangeOptions {
    /** What was typed in the search box. Blank lists everything. */
    query?: string;
    /** One section only, or every section when absent. */
    category?: ConnectionCategory | null;
}

/** Lowercased and without accents, so "telefono" finds "Teléfono". */
function fold(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

export function matchesQuery(provider: ArrangeableProvider, query: string | undefined): boolean {
    const wanted = fold(query ?? "");
    if (!wanted) return true;
    return [provider.name, provider.slug, provider.summary ?? ""].some((field) =>
        fold(field).includes(wanted)
    );
}

/**
 * The sections the screen draws: filtered, then each one with its connected
 * services first. The sort is stable, so within "connected" and "not connected"
 * every service keeps the catalogue's own order.
 */
export function arrangeProviders<T extends ArrangeableProvider>(
    providers: readonly T[],
    options: ArrangeOptions = {}
): { id: ConnectionCategory; label: string; providers: T[] }[] {
    const shown = providers.filter(
        (provider) =>
            (!options.category || provider.category === options.category) &&
            matchesQuery(provider, options.query)
    );
    return connectionSections(shown).map((section) => ({
        ...section,
        providers: [...section.providers].sort(
            (a, b) => Number(b.accounts.length > 0) - Number(a.accounts.length > 0)
        )
    }));
}
