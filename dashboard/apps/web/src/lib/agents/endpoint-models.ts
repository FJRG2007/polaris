/**
 * The models a provider outside the public index serves, read from its own
 * endpoint.
 *
 * The index carries no models for a provider reached by its endpoint (Coarena,
 * an operator's own), so without this a picker offers only the one model its
 * row names. Each such endpoint is asked `GET {baseUrl}/models` - the
 * OpenAI-compatible list, `{ data: [{ id }] }` - and what it answers is stored
 * in the model catalogue under the provider's slug, refreshed with the rest of
 * it once a day.
 *
 * Bounded everywhere, because the address is somebody else's choice: at most
 * `MAX_PROVIDERS` endpoints, `MAX_MODELS` models each, `MAX_BYTES` of answer,
 * and every request through the guarded fetch, so a name that resolves to a
 * private address is refused when it is asked. No key is sent: a refresh runs
 * for nobody in particular, and an endpoint that only lists models to a key
 * keeps offering the model its row names.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { configuredRequest, readCapped } from "@/lib/safe-fetch";
import { catalogProviders } from "@/lib/integrations/provider-catalog-snapshot";

/** Most endpoints asked in one refresh. */
export const MAX_PROVIDERS = 50;
/** Most models kept from one endpoint. */
export const MAX_MODELS = 200;
/** Most bytes read from one answer. */
export const MAX_BYTES = 1024 * 1024;
/** How long one endpoint may take to answer. */
const TIMEOUT_MS = 10_000;
/** Endpoints asked at once. */
const PARALLEL = 5;

/** A model id as a picker and a run can carry it. */
const modelId = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\s/][^\s]*$/);

/** Only what is read: the id of each entry. Entries that are not usable are
 *  skipped rather than failing the whole list. */
const modelListSchema = z.object({ data: z.array(z.unknown()).max(10_000) });
const entrySchema = z.object({ id: modelId, name: z.string().trim().min(1).max(200).optional() });

/** One endpoint's answer as model rows, or an empty list for anything else. Pure. */
export function parseEndpointModels(
    provider: string,
    payload: unknown
): Array<{ slug: string; provider: string; modelId: string; name: string }> {
    const parsed = modelListSchema.safeParse(payload);
    if (!parsed.success) return [];
    const seen = new Set<string>();
    const rows: Array<{ slug: string; provider: string; modelId: string; name: string }> = [];
    for (const raw of parsed.data.data) {
        const entry = entrySchema.safeParse(raw);
        if (!entry.success || seen.has(entry.data.id)) continue;
        seen.add(entry.data.id);
        rows.push({
            slug: `${provider}/${entry.data.id}`,
            provider,
            modelId: entry.data.id,
            name: entry.data.name ?? entry.data.id
        });
        if (rows.length >= MAX_MODELS) break;
    }
    return rows;
}

/** The providers reached by an endpoint of their own, at most `MAX_PROVIDERS`. */
export function endpointProviders(only?: readonly string[]): Array<{ slug: string; baseUrl: string }> {
    const wanted = only ? new Set(only) : null;
    const found: Array<{ slug: string; baseUrl: string }> = [];
    for (const row of catalogProviders()) {
        if (!row.outsideIndex || !row.baseUrl || (wanted && !wanted.has(row.slug))) continue;
        found.push({ slug: row.slug, baseUrl: row.baseUrl.replace(/\/+$/, "") });
        if (found.length >= MAX_PROVIDERS) break;
    }
    return found;
}

/** One endpoint's model list, or null when it could not be read. */
async function readEndpoint(provider: { slug: string; baseUrl: string }) {
    try {
        const response = await configuredRequest(
            `${provider.baseUrl}/models`,
            { method: "GET", headers: { accept: "application/json" }, timeoutMs: TIMEOUT_MS },
            { allowPrivate: false }
        );
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const bytes = await readCapped(
            response as unknown as Parameters<typeof readCapped>[0],
            MAX_BYTES
        );
        if (!bytes) return null;
        return parseEndpointModels(provider.slug, JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

/**
 * Read every endpoint's models and store them, replacing what was stored for
 * that provider. An endpoint that does not answer, or answers with nothing
 * usable, keeps what was stored before: a failed read is not a provider that
 * stopped serving models. Returns how many models were stored.
 */
export async function refreshEndpointModels(only?: readonly string[]): Promise<number> {
    const providers = endpointProviders(only);
    let stored = 0;
    for (let i = 0; i < providers.length; i += PARALLEL) {
        const batch = providers.slice(i, i + PARALLEL);
        const lists = await Promise.all(batch.map(readEndpoint));
        for (const [index, rows] of lists.entries()) {
            if (!rows || rows.length === 0) continue;
            const provider = batch[index]!.slug;
            const now = new Date();
            await prisma
                .$transaction([
                    prisma.agentModel.deleteMany({ where: { provider } }),
                    prisma.agentModel.createMany({
                        data: rows.map((row) => ({ ...row, refreshedAt: now })),
                        skipDuplicates: true
                    })
                ])
                .then(() => {
                    stored += rows.length;
                })
                .catch((error: unknown) =>
                    console.error(`polar: could not store ${provider}'s models`, error)
                );
        }
    }
    return stored;
}

/** Forget a removed provider's models. */
export async function forgetEndpointModels(provider: string): Promise<void> {
    try {
        await prisma.agentModel.deleteMany({ where: { provider } });
    } catch (error) {
        // Left behind, they are rows no picker reaches: the provider is gone.
        console.error(`polar: could not forget ${provider}'s models`, error);
    }
}
