"use server";

/**
 * The provider picker's pages. One action for the account's keys and the
 * deployment's: both pick from the same catalogue, and a signed-in person may
 * see which providers exist whichever screen they are on.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { providerRow, type ProviderRow } from "@/lib/agents/model-key-providers";
import {
    ensureProviderCatalog,
    providerHits,
    searchProviderCatalog
} from "@/lib/integrations/provider-catalog";

/** Rows on one page of the picker. */
const PAGE = 24;

const inputSchema = z.object({
    query: z.string().max(200).default(""),
    kind: z.enum(["lab", "host", "gateway", "listed", "custom"]).nullish(),
    free: z.enum(["any", "free", "trial"]).nullish(),
    cursor: z
        .string()
        .regex(/^\d{1,6}$/)
        .nullish(),
    /** Read these back by slug instead of searching: the picker naming a value. */
    ids: z.array(z.string().min(1).max(80)).max(10).optional()
});

export async function searchKeyProvidersAction(
    input: unknown
): Promise<{ items: ProviderRow[]; next: string | null } | { error: string }> {
    await requireUser();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return { items: [], next: null };
    const { query, kind, free, cursor, ids } = parsed.data;
    await ensureProviderCatalog();
    const row = (hit: { slug: string; name: string; freeTier: ProviderRow["freeTier"] }) =>
        providerRow(hit.slug, { name: hit.name, freeTier: hit.freeTier });
    if (ids) return { items: (await providerHits(ids)).map(row), next: null };
    const page = await searchProviderCatalog({
        query: query.trim().slice(0, 80),
        kind,
        free,
        offset: cursor ? Number(cursor) : 0,
        take: PAGE
    });
    return { items: page.hits.map(row), next: page.next === null ? null : String(page.next) };
}
