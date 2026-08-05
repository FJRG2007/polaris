/**
 * Which models a provider serves, and what each one can hold.
 *
 * Polaris used to carry one model per provider, written down by hand. That is
 * wrong within weeks - providers add and retire models constantly - and it left
 * whoever connected a key with a single choice and no information about it. The
 * catalogue is downloaded instead, from the same public index the agent runtimes
 * resolve against, so a picker offers what the account can actually run and can
 * say what it holds before a run finds out.
 *
 * Two things it deliberately does not claim:
 *
 *   - A context window is not an allowance. What stops most runs is the plan's
 *     per-minute ceiling, which is a property of the account and is published
 *     nowhere. The numbers here bound one request; they cannot promise a run
 *     will be served.
 *   - Absence is not failure. A deployment that has never reached the index, or
 *     that has no outbound network, falls back to the one default per provider
 *     in the integrations registry. Every read here is allowed to return
 *     nothing, and every caller has to cope with that.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { MODEL_PROVIDERS } from "@/lib/agents/agent-providers";

/** Where the catalogue comes from. Public, unauthenticated, and the same index
 *  the agent CLIs resolve model ids against, so what Polaris offers and what a
 *  run can address are the same list. */
const CATALOG_URL = "https://models.dev/api.json";

/** Long enough that the download is not on anybody's critical path, short enough
 *  that a deployment does not sit on a dead request. */
const FETCH_TIMEOUT_MS = 20_000;

/** How stale the catalogue may be before a refresh is due. Providers move
 *  faster than a week and slower than an hour; a day is the honest middle, and
 *  the refresh is one request. */
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * What a model has to be able to do before Polaris offers it for a run.
 *
 * An agent is a tool-calling loop. A model that cannot call tools cannot be one,
 * however good it is - and the providers' catalogues are full of models that are
 * not chat models at all. The unfiltered list is where `whisper-large-v3` and
 * `llama-prompt-guard` came from: a speech recogniser and a safety classifier,
 * offered as things to run an agent on.
 */
export function isUsableForAgents(model: RawModel): boolean {
    return model.tool_call === true && (model.limit?.context ?? 0) > 0;
}

/** Only what is read. The index carries a great deal more per model, and a
 *  schema that accepted all of it would break on the next field they add. */
const rawModelSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    tool_call: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    attachment: z.boolean().optional(),
    release_date: z.string().optional(),
    limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
    cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
    reasoning_options: z
        .array(z.object({ type: z.string(), values: z.array(z.string()) }))
        .optional()
});

type RawModel = z.infer<typeof rawModelSchema>;

const catalogSchema = z.record(
    z.string(),
    z.object({ models: z.record(z.string(), z.unknown()) }).partial({ models: true })
);

/** The effort ladder, when the model publishes one. Only the `effort` kind is
 *  read: it is the one the runtimes map a level onto, and a different kind of
 *  option means the model has no effort control to offer. */
function effortRungs(model: RawModel): string[] {
    return model.reasoning_options?.find((option) => option.type === "effort")?.values ?? [];
}

/** One catalogue row as a screen reads it. */
export interface CatalogModel {
    slug: string;
    provider: string;
    modelId: string;
    name: string;
    contextTokens: number;
    outputTokens: number;
    effortRungs: string[];
    reasoning: boolean;
    attachment: boolean;
    costInput: number | null;
    costOutput: number | null;
    releaseDate: string | null;
}

type ModelRow = {
    slug: string;
    provider: string;
    modelId: string;
    name: string;
    contextTokens: number;
    outputTokens: number;
    effortRungs: string;
    reasoning: boolean;
    attachment: boolean;
    costInput: number | null;
    costOutput: number | null;
    releaseDate: string | null;
};

function toModel(row: ModelRow): CatalogModel {
    let rungs: string[] = [];
    try {
        const parsed: unknown = JSON.parse(row.effortRungs);
        if (Array.isArray(parsed)) rungs = parsed.filter((value): value is string => typeof value === "string");
    } catch {
        // A row written by a newer shape, or corrupted. No rungs is the safe
        // reading: the setting becomes a documented no-op rather than sending
        // the provider a level it never published.
    }
    return { ...row, effortRungs: rungs };
}

const SELECT = {
    slug: true,
    provider: true,
    modelId: true,
    name: true,
    contextTokens: true,
    outputTokens: true,
    effortRungs: true,
    reasoning: true,
    attachment: true,
    costInput: true,
    costOutput: true,
    releaseDate: true
} as const;

/**
 * Every model in the catalogue for the providers named, newest first.
 *
 * Ordered by release date because that is the order somebody picking a model
 * thinks in, and a provider's catalogue is otherwise an alphabetical soup of
 * five generations. A model with no date sorts last rather than first: an absent
 * date is unknown, not new.
 */
export async function listCatalogModels(providers?: readonly string[]): Promise<CatalogModel[]> {
    const rows = await prisma.agentModel.findMany({
        where: providers ? { provider: { in: [...providers] } } : undefined,
        select: SELECT,
        orderBy: [{ releaseDate: "desc" }, { name: "asc" }]
    });
    return rows.map(toModel);
}

/** One model by its slug, or null when the catalogue does not carry it - a raw
 *  specifier somebody typed, or a provider Polaris does not index. */
export async function getCatalogModel(slug: string): Promise<CatalogModel | null> {
    const row = await prisma.agentModel.findUnique({ where: { slug }, select: SELECT });
    return row ? toModel(row) : null;
}

/** When the catalogue was last written, or null if it never has been. */
export async function catalogRefreshedAt(): Promise<Date | null> {
    const newest = await prisma.agentModel.findFirst({
        select: { refreshedAt: true },
        orderBy: { refreshedAt: "desc" }
    });
    return newest?.refreshedAt ?? null;
}

/**
 * The downloaded index, reduced to the rows Polaris stores.
 *
 * Apart from the download so the filtering can be tested against a payload
 * rather than against the internet, and so a shape the index changes tomorrow
 * fails one test instead of a deployment. Anything unrecognised is skipped
 * rather than thrown on: a provider adding a field must not stop the refresh.
 */
export function parseCatalogPayload(payload: unknown): ModelRow[] {
    const parsed = catalogSchema.safeParse(payload);
    if (!parsed.success) return [];

    const wanted = new Set(MODEL_PROVIDERS.map((provider) => provider.modelPrefix));
    const rows: ModelRow[] = [];
    for (const [providerId, entry] of Object.entries(parsed.data)) {
        if (!wanted.has(providerId)) continue;
        for (const raw of Object.values(entry.models ?? {})) {
            const model = rawModelSchema.safeParse(raw);
            if (!model.success || !isUsableForAgents(model.data)) continue;
            const data = model.data;
            rows.push({
                slug: `${providerId}/${data.id}`,
                provider: providerId,
                modelId: data.id,
                name: data.name ?? data.id,
                contextTokens: Math.max(0, Math.trunc(data.limit?.context ?? 0)),
                outputTokens: Math.max(0, Math.trunc(data.limit?.output ?? 0)),
                effortRungs: JSON.stringify(effortRungs(data)),
                reasoning: data.reasoning === true,
                attachment: data.attachment === true,
                costInput: data.cost?.input ?? null,
                costOutput: data.cost?.output ?? null,
                releaseDate: data.release_date ?? null
            });
        }
    }
    return rows;
}

/** What a refresh did, for the screen that asked for one. */
export interface CatalogRefresh {
    ok: boolean;
    models: number;
    /** In the operator's words, when it did not work. */
    error?: string;
}

/**
 * Fetch the catalogue and replace what is stored for the providers Polaris
 * carries credentials for.
 *
 * Written as a delete-then-insert inside one transaction, scoped to those
 * providers: a model a provider has retired must stop being offered, and an
 * upsert-only refresh would keep it forever. Providers Polaris does not index
 * are left untouched rather than deleted, so nothing is lost if the supported
 * list shrinks in a later release.
 */
export async function refreshModelCatalog(): Promise<CatalogRefresh> {
    let payload: unknown;
    try {
        const response = await fetch(CATALOG_URL, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { accept: "application/json" },
            cache: "no-store"
        });
        if (!response.ok) return { ok: false, models: 0, error: `The catalogue answered ${response.status}.` };
        payload = await response.json();
    } catch (error) {
        // Offline, blocked, or slow. All of them mean the same thing to a
        // caller: keep whatever is stored and try again later.
        return {
            ok: false,
            models: 0,
            error: error instanceof Error ? error.message : "The catalogue could not be reached."
        };
    }

    const rows = parseCatalogPayload(payload);

    // An empty result is a bad download, not an empty world: replacing the
    // stored catalogue with nothing would leave every picker with one model per
    // provider until the next refresh happened to work.
    if (rows.length === 0) return { ok: false, models: 0, error: "The catalogue listed no usable models." };

    const providers = [...new Set(rows.map((row) => row.provider))];
    await prisma.$transaction([
        prisma.agentModel.deleteMany({ where: { provider: { in: providers } } }),
        prisma.agentModel.createMany({ data: rows.map((row) => ({ ...row, refreshedAt: new Date() })) })
    ]);
    return { ok: true, models: rows.length };
}

/** Refresh only when what is stored has aged out, so a caller can ask on every
 *  tick without asking the index every time. */
export async function refreshModelCatalogIfStale(): Promise<CatalogRefresh | null> {
    const at = await catalogRefreshedAt();
    if (at && Date.now() - at.getTime() < CATALOG_MAX_AGE_MS) return null;
    return await refreshModelCatalog();
}
