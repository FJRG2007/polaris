/**
 * The AI provider catalogue, stored.
 *
 * A marketplace of thousands cannot be a TypeScript array: every provider added
 * would be a release, and every screen that drew the list would ship all of it.
 * So the catalogue is rows (`ModelProviderEntry`), filled from three places:
 *
 *   - builtin and seed rows, written from code on every boot (the hand-written
 *     registry entries and the table in `model-providers.ts`). Idempotent: a
 *     row already matching its code is not written again.
 *   - index rows, from the public model index (models.dev) on the catalogue's
 *     daily refresh. Validated, bounded in size, sent with the last ETag, and a
 *     failed or empty download keeps the rows already stored.
 *   - custom rows, an OpenAI- or Anthropic-compatible endpoint an operator adds
 *     from the AI providers screen.
 *
 * The synchronous readers (which provider a model needs, the variable a run
 * reads, the endpoint a key is checked at) read the copy this module keeps in
 * `provider-catalog-snapshot.ts`; screens page through `searchProviderCatalog`,
 * so no browser is ever handed the whole list.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";
import { PROVIDER_ALIASES } from "@/lib/integrations/provider-aliases";
import { SPEECH_PROVIDER_SEEDS } from "@/lib/integrations/speech-providers";
import type { ModelProviderSeed, ProviderKind } from "@/lib/integrations/model-providers";
import {
    catalogProviders,
    replaceCatalogProviders,
    seedCatalogProviders,
    type CatalogProvider,
    type CatalogSource
} from "@/lib/integrations/provider-catalog-snapshot";

/** The hand-written providers' variables (`agent-providers.ts`), which nothing
 *  from the index or an operator may claim. Written here rather than imported,
 *  since that module reads this one's snapshot. */
const BUILTIN_ENV: Readonly<Record<string, string>> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    "google-ai": "GEMINI_API_KEY",
    xai: "XAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    openrouter: "OPENROUTER_API_KEY"
};

/** Index ids that are deliberately not offered: clouds that need more than one
 *  credential (an access key and a secret, a project and a region), and agent
 *  subscriptions whose token is not an API key. The multi-credential ones are
 *  also caught by having more than one variable; named so the rule is visible. */
export const INDEX_EXCLUDED: ReadonlySet<string> = new Set([
    "amazon-bedrock",
    "azure",
    "azure-cognitive-services",
    "google-vertex",
    "google-vertex-anthropic",
    "github-copilot",
    "github-models",
    "gitlab",
    "cloudflare-workers-ai",
    "cloudflare-ai-gateway",
    "sap-ai-core"
]);

/** The index's ids the hand-written providers are filed under there. */
const BUILTIN_INDEX_IDS: ReadonlySet<string> = new Set([
    ...Object.keys(BUILTIN_ENV),
    "google",
    "moonshotai"
]);

/** Largest index download read. The whole index is a few megabytes; anything
 *  far past that is not the index. */
export const INDEX_MAX_BYTES = 32 * 1024 * 1024;

/** Most providers taken from one download, so a hostile or broken index cannot
 *  fill the table without bound. */
export const INDEX_MAX_PROVIDERS = 5000;

const INDEX_URL = "https://models.dev/api.json";
const INDEX_TIMEOUT_MS = 20_000;
const STATE_ID = "index";

/** How long the snapshot is trusted before a request reads the store again. */
const SNAPSHOT_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const SELECT = {
    slug: true,
    name: true,
    kind: true,
    source: true,
    envVar: true,
    summary: true,
    docsUrl: true,
    keyUrl: true,
    probe: true,
    baseUrl: true,
    wire: true,
    anthropicBaseUrl: true,
    outsideIndex: true,
    defaultModelSlug: true,
    defaultModelLabel: true,
    freeKind: true,
    freeNote: true
} as const;

type Row = {
    slug: string;
    name: string;
    kind: string;
    source: string;
    envVar: string;
    summary: string;
    docsUrl: string;
    keyUrl: string | null;
    probe: string | null;
    baseUrl: string | null;
    wire: string | null;
    anthropicBaseUrl: string | null;
    outsideIndex: boolean;
    defaultModelSlug: string;
    defaultModelLabel: string;
    freeKind: string | null;
    freeNote: string | null;
};

const KINDS: readonly ProviderKind[] = ["lab", "host", "gateway", "listed"];

/** A stored row as the readers take it. Null for a builtin row, which the
 *  readers carry in code. */
export function rowToProvider(row: Row): CatalogProvider | null {
    if (row.source === "builtin") return null;
    const source: CatalogSource =
        row.source === "index" || row.source === "custom" ? row.source : "seed";
    const kind = (KINDS as readonly string[]).includes(row.kind) ? (row.kind as ProviderKind) : "listed";
    return {
        slug: row.slug,
        name: row.name,
        kind,
        source,
        envVar: row.envVar,
        summary: row.summary,
        docsUrl: row.docsUrl,
        keyUrl: row.keyUrl ?? undefined,
        probe: row.probe ?? undefined,
        baseUrl: row.baseUrl ?? undefined,
        wire: row.wire === "anthropic" ? "anthropic" : row.wire === "openai" ? "openai" : undefined,
        anthropicBaseUrl: row.anthropicBaseUrl ?? undefined,
        outsideIndex: row.outsideIndex || undefined,
        defaultModel: { label: row.defaultModelLabel, slug: row.defaultModelSlug },
        free:
            row.freeKind === "free" || row.freeKind === "trial"
                ? { kind: row.freeKind, note: row.freeNote ?? "" }
                : undefined
    };
}

/** What the search matches: the name, the slug and the words people use. */
export function searchTextOf(slug: string, name: string): string {
    return [name, slug, ...(PROVIDER_ALIASES[slug] ?? [])].join(" ").toLowerCase();
}

/** A provider as the row written for it. */
export function providerToRow(
    seed: ModelProviderSeed,
    source: CatalogSource | "builtin",
    rank: number
): Row & { rank: number; searchText: string } {
    return {
        slug: seed.slug,
        name: seed.name,
        kind: seed.kind,
        source,
        rank,
        envVar: seed.envVar,
        summary: seed.summary,
        docsUrl: seed.docsUrl,
        keyUrl: seed.keyUrl ?? null,
        probe: seed.probe ?? null,
        baseUrl: seed.baseUrl ?? null,
        wire: seed.wire ?? null,
        anthropicBaseUrl: seed.anthropicBaseUrl ?? null,
        outsideIndex: seed.outsideIndex === true,
        defaultModelSlug: seed.defaultModel.slug,
        defaultModelLabel: seed.defaultModel.label,
        freeKind: seed.free?.kind ?? null,
        freeNote: seed.free?.note ?? null,
        searchText: searchTextOf(seed.slug, seed.name)
    };
}

/** The hand-written registry entries, as rows, so the search lists them first. */
function builtinRows(): Array<Row & { rank: number; searchText: string }> {
    const seeded = new Set(seedCatalogProviders().map((seed) => seed.slug));
    return MODEL_INTEGRATIONS.filter((entry) => !seeded.has(entry.slug)).map((entry, index) =>
        providerToRow(
            {
                slug: entry.slug,
                name: entry.name,
                kind: "lab",
                envVar: BUILTIN_ENV[entry.slug] ?? "",
                summary: entry.summary,
                docsUrl: entry.docsUrl ?? "",
                keyUrl: entry.setupLinks?.[0]?.url,
                defaultModel: entry.defaultModel ?? { label: "", slug: "" },
                free: entry.freeTier
            },
            "builtin",
            index
        )
    );
}

function sameRow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    return Object.keys(b).every((key) => (a[key] ?? null) === (b[key] ?? null));
}

// ---------------------------------------------------------------------------
// Seeding and the snapshot
// ---------------------------------------------------------------------------

/**
 * Write the code's providers into the store. Idempotent: a row already equal to
 * its code is left alone, so a boot after the first writes nothing. A custom or
 * index row that took a seeded slug before the seed existed is overwritten,
 * since the seed is the curated description of that provider.
 */
export async function seedProviderCatalog(): Promise<{ written: number }> {
    const wanted = [
        ...builtinRows(),
        ...seedCatalogProviders().map((seed) => providerToRow(seed, "seed", 50))
    ];
    const existing = await prisma.modelProviderEntry.findMany({
        where: { slug: { in: wanted.map((row) => row.slug) } },
        select: { ...SELECT, rank: true, searchText: true }
    });
    const bySlug = new Map(existing.map((row) => [row.slug, row]));
    const changed = wanted.filter((row) => {
        const stored = bySlug.get(row.slug);
        return !stored || !sameRow(stored, row);
    });
    for (let i = 0; i < changed.length; i += 100) {
        await prisma.$transaction(
            changed.slice(i, i + 100).map((row) =>
                prisma.modelProviderEntry.upsert({
                    where: { slug: row.slug },
                    create: row,
                    update: row
                })
            )
        );
    }
    return { written: changed.length };
}

/** Read every provider the readers need into the snapshot. */
export async function loadProviderCatalog(): Promise<number> {
    const rows = await prisma.modelProviderEntry.findMany({
        where: { source: { not: "builtin" } },
        select: SELECT,
        orderBy: [{ rank: "asc" }, { name: "asc" }],
        take: INDEX_MAX_PROVIDERS + 2000
    });
    const providers = rows.map(rowToProvider).filter((row): row is CatalogProvider => row !== null);
    replaceCatalogProviders(providers);
    return providers.length;
}

let loadedAt = 0;
let seeded = false;
let inFlight: Promise<void> | null = null;

/**
 * Make the snapshot current: seeds the store once per process, then reads it at
 * most once a minute. Never throws - a store that cannot be read leaves the
 * snapshot as it was (the seed table at worst), which every reader copes with.
 */
export async function ensureProviderCatalog(force = false): Promise<void> {
    if (!force && Date.now() - loadedAt < SNAPSHOT_TTL_MS) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            if (!seeded) {
                await seedProviderCatalog();
                seeded = true;
            }
            await loadProviderCatalog();
            loadedAt = Date.now();
        } catch (error) {
            console.error(
                "polaris: provider catalogue not read:",
                error instanceof Error ? error.message : "unknown"
            );
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

// ---------------------------------------------------------------------------
// The public index
// ---------------------------------------------------------------------------

const httpsUrl = z
    .string()
    .url()
    .max(500)
    .refine((value) => value.startsWith("https://"));

const indexModelSchema = z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    tool_call: z.boolean().optional(),
    release_date: z.string().max(40).optional(),
    limit: z.object({ context: z.number().optional() }).partial().optional()
});

const indexProviderSchema = z.object({
    id: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9.-]*$/),
    name: z.string().min(1).max(120),
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/)),
    npm: z.string().max(120).optional(),
    api: httpsUrl.optional(),
    doc: httpsUrl.optional(),
    models: z.record(z.string(), z.unknown()).optional()
});

/**
 * The providers in an index download that Polaris can offer, as rows. Pure.
 *
 * Kept: a provider with exactly one variable (more is a cloud needing several
 * credentials), not deliberately excluded, not one already curated in code, and
 * with at least one model an agent can run (tools and a context window). Its
 * default is the newest such model. Its variable must be one no provider
 * already in `taken` reads, or the second key would overwrite the first.
 */
export function parseProviderIndex(
    payload: unknown,
    taken: { slugs: ReadonlySet<string>; envVars: ReadonlySet<string> }
): ModelProviderSeed[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const out: ModelProviderSeed[] = [];
    const envVars = new Set(taken.envVars);
    for (const raw of Object.values(payload as Record<string, unknown>)) {
        if (out.length >= INDEX_MAX_PROVIDERS) break;
        const parsed = indexProviderSchema.safeParse(raw);
        if (!parsed.success) continue;
        const provider = parsed.data;
        if (provider.env.length !== 1) continue;
        if (INDEX_EXCLUDED.has(provider.id) || BUILTIN_INDEX_IDS.has(provider.id)) continue;
        if (taken.slugs.has(provider.id)) continue;
        const envVar = provider.env[0]!;
        if (envVars.has(envVar)) continue;
        const best = Object.values(provider.models ?? {})
            .map((model) => indexModelSchema.safeParse(model))
            .filter((model) => model.success)
            .map((model) => model.data)
            .filter((model) => model.tool_call === true && (model.limit?.context ?? 0) > 0)
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))[0];
        if (!best) continue;
        const wire =
            provider.npm === "@ai-sdk/openai-compatible"
                ? "openai"
                : provider.npm === "@ai-sdk/anthropic" && provider.api
                  ? "anthropic"
                  : undefined;
        envVars.add(envVar);
        out.push({
            slug: provider.id,
            name: provider.name,
            kind: "listed",
            envVar,
            summary: "", // the description says what is known; nothing more is
            docsUrl: provider.doc ?? "",
            defaultModel: {
                label: `${best.name ?? best.id} (${provider.name})`,
                slug: `${provider.id}/${best.id}`
            },
            ...(wire && provider.api ? { baseUrl: provider.api.replace(/\/+$/, ""), wire } : {})
        });
    }
    return out;
}

export type IndexDownload =
    | { state: "fresh"; payload: unknown; etag: string | null }
    | { state: "unchanged" }
    | { state: "failed"; error: string };

/**
 * Download the index, sending the validator from the last good download and
 * refusing a body past `INDEX_MAX_BYTES` (by its header and as it streams).
 */
export async function downloadModelIndex(): Promise<IndexDownload> {
    const state = await prisma.modelProviderIndexState
        .findUnique({ where: { id: STATE_ID }, select: { etag: true } })
        .catch(() => null);
    try {
        const response = await fetch(INDEX_URL, {
            signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
            headers: {
                accept: "application/json",
                ...(state?.etag ? { "if-none-match": state.etag } : {})
            },
            cache: "no-store"
        });
        if (response.status === 304) return { state: "unchanged" };
        if (!response.ok) return { state: "failed", error: `index answered ${response.status}` };
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > INDEX_MAX_BYTES) return { state: "failed", error: "index too large" };
        const text = await readCapped(response, INDEX_MAX_BYTES);
        if (text === null) return { state: "failed", error: "index too large" };
        return { state: "fresh", payload: JSON.parse(text), etag: response.headers.get("etag") };
    } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : "unreachable" };
    }
}

async function readCapped(response: Response, max: number): Promise<string | null> {
    if (!response.body) return await response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * Store the index's providers from one download. A download with none in it is
 * a bad download, not an empty world: the stored rows stay and the failure is
 * remembered. Index rows are only ever added or updated, never removed, so a
 * provider the index drops keeps working for the keys already stored for it.
 */
export async function storeProviderIndex(
    payload: unknown,
    etag: string | null
): Promise<{ ok: boolean; providers: number; error?: string }> {
    const others = await prisma.modelProviderEntry.findMany({
        where: { source: { not: "index" } },
        select: { slug: true, envVar: true },
        take: INDEX_MAX_PROVIDERS + 2000
    });
    const taken = {
        slugs: new Set([...others.map((row) => row.slug), ...SPEECH_PROVIDER_SEEDS.map((s) => s.slug)]),
        // Index rows are rewritten from this download, so only the variables of
        // everything else are off limits; the download is deduplicated in parse.
        envVars: new Set(
            [
                ...others.map((row) => row.envVar),
                ...Object.values(BUILTIN_ENV),
                ...SPEECH_PROVIDER_SEEDS.map((s) => s.envVar)
            ].filter(Boolean)
        )
    };
    const providers = parseProviderIndex(payload, taken);
    if (providers.length === 0) {
        await rememberIndex({ lastError: "index carried no usable provider" });
        return { ok: false, providers: 0, error: "index carried no usable provider" };
    }
    const rows = providers.map((seed) => providerToRow(seed, "index", 200));
    for (let i = 0; i < rows.length; i += 100) {
        await prisma.$transaction(
            rows.slice(i, i + 100).map((row) =>
                prisma.modelProviderEntry.upsert({
                    where: { slug: row.slug },
                    create: row,
                    update: row
                })
            )
        );
    }
    await rememberIndex({ etag, refreshedAt: new Date(), providers: rows.length, lastError: null });
    await loadProviderCatalog().catch(() => undefined);
    return { ok: true, providers: rows.length };
}

async function rememberIndex(data: {
    etag?: string | null;
    refreshedAt?: Date;
    providers?: number;
    lastError: string | null;
}): Promise<void> {
    await prisma.modelProviderIndexState
        .upsert({ where: { id: STATE_ID }, create: { id: STATE_ID, ...data }, update: data })
        .catch(() => undefined);
}

/** Note a failed download without touching what is stored. */
export async function noteIndexFailure(error: string): Promise<void> {
    await rememberIndex({ lastError: error.slice(0, 500) });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const providerSearchSchema = z.object({
    query: z.string().trim().max(80).default(""),
    kind: z.enum(["lab", "host", "gateway", "listed", "custom"]).nullish(),
    free: z.enum(["any", "free", "trial"]).nullish(),
    offset: z.number().int().min(0).max(100_000).default(0),
    take: z.number().int().min(1).max(50).default(24)
});

export type ProviderSearch = z.input<typeof providerSearchSchema>;

/** One provider as a picker row. */
export interface ProviderHit {
    slug: string;
    name: string;
    kind: string;
    source: string;
    freeTier: { kind: "free" | "trial"; note: string } | null;
}

/**
 * One page of the catalogue, filtered and searched in the database. The
 * hand-written providers come first, then by name. `next` is the offset of the
 * following page, or null on the last.
 */
export async function searchProviderCatalog(
    input: ProviderSearch
): Promise<{ hits: ProviderHit[]; next: number | null }> {
    const search = providerSearchSchema.parse(input);
    const words = search.query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    const where = {
        AND: [
            ...words.map((word) => ({ searchText: { contains: word } })),
            ...(search.kind === "custom"
                ? [{ source: "custom" }]
                : search.kind
                  ? [{ kind: search.kind }]
                  : []),
            ...(search.free === "any"
                ? [{ freeKind: { not: null } }]
                : search.free
                  ? [{ freeKind: search.free }]
                  : [])
        ]
    };
    const rows = await prisma.modelProviderEntry.findMany({
        where,
        select: { slug: true, name: true, kind: true, source: true, freeKind: true, freeNote: true },
        orderBy: [{ rank: "asc" }, { name: "asc" }, { slug: "asc" }],
        skip: search.offset,
        take: search.take + 1
    });
    const hits = rows.slice(0, search.take).map(
        (row): ProviderHit => ({
            slug: row.slug,
            name: row.name,
            kind: row.kind,
            source: row.source,
            freeTier:
                row.freeKind === "free" || row.freeKind === "trial"
                    ? { kind: row.freeKind, note: row.freeNote ?? "" }
                    : null
        })
    );
    return { hits, next: rows.length > search.take ? search.offset + search.take : null };
}

/** The names of these providers, for a screen that lists keys by provider. */
export async function providerNames(slugs: readonly string[]): Promise<Record<string, string>> {
    const unique = [...new Set(slugs)].slice(0, 500);
    if (unique.length === 0) return {};
    const rows = await prisma.modelProviderEntry.findMany({
        where: { slug: { in: unique } },
        select: { slug: true, name: true }
    });
    return Object.fromEntries(rows.map((row) => [row.slug, row.name]));
}

// ---------------------------------------------------------------------------
// Operator-added providers
// ---------------------------------------------------------------------------

/** Hosts an operator-added endpoint may not name: this machine and the
 *  networks it sits in, which a server-side request would otherwise probe. */
export function isPublicHttpsHost(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
    return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host);
}

const publicUrl = z
    .string()
    .trim()
    .max(500)
    .refine(isPublicHttpsHost, { message: "publicHttps" });

/** What the Add provider form sends. */
export const customProviderSchema = z.object({
    name: z.string().trim().min(2).max(60),
    baseUrl: publicUrl,
    wire: z.enum(["openai", "anthropic"]),
    envVar: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9_]{2,62}$/, { message: "envVar" })
        .refine((value) => !/^(POLARIS_|OPENCODE_|PATH$|HOME$|NODE_)/.test(value), {
            message: "envVarReserved"
        }),
    defaultModel: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^\s/][^\s]*$/, { message: "model" }),
    probe: publicUrl.optional().or(z.literal("").transform(() => undefined)),
    docsUrl: publicUrl.optional().or(z.literal("").transform(() => undefined))
});

export type CustomProviderInput = z.input<typeof customProviderSchema>;

/** A display name as a slug: lowercase words joined by dashes. */
export function slugifyProviderName(name: string): string {
    return name
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

export type CustomProviderRefusal = "taken" | "envTaken" | "invalid";

/** The seed a custom provider is stored as. Pure, so the rules are testable. */
export function customProviderSeed(
    input: z.output<typeof customProviderSchema>,
    existing: readonly { slug: string; envVar: string }[]
): ModelProviderSeed | CustomProviderRefusal {
    const slug = slugifyProviderName(input.name);
    if (slug.length < 2) return "invalid";
    const reserved = new Set([
        ...existing.map((row) => row.slug),
        ...Object.keys(BUILTIN_ENV),
        "enigma",
        ...SPEECH_PROVIDER_SEEDS.map((s) => s.slug)
    ]);
    if (reserved.has(slug)) return "taken";
    const envs = new Set([
        ...existing.map((row) => row.envVar),
        ...Object.values(BUILTIN_ENV),
        ...SPEECH_PROVIDER_SEEDS.map((s) => s.envVar)
    ]);
    if (envs.has(input.envVar)) return "envTaken";
    return {
        slug,
        name: input.name,
        kind: "gateway",
        envVar: input.envVar,
        summary: "",
        docsUrl: input.docsUrl ?? input.baseUrl,
        probe: input.probe,
        outsideIndex: true,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        wire: input.wire,
        defaultModel: { label: input.defaultModel, slug: `${slug}/${input.defaultModel}` }
    };
}

/** Store an operator-added provider. */
export async function addCustomProvider(
    input: unknown,
    actorId: string
): Promise<{ ok: true; slug: string } | { ok: false; reason: CustomProviderRefusal }> {
    const parsed = customProviderSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const existing = await prisma.modelProviderEntry.findMany({
        select: { slug: true, envVar: true },
        take: INDEX_MAX_PROVIDERS + 2000
    });
    const seed = customProviderSeed(parsed.data, [
        ...existing,
        ...catalogProviders().map((row) => ({ slug: row.slug, envVar: row.envVar }))
    ]);
    if (typeof seed === "string") return { ok: false, reason: seed };
    await prisma.modelProviderEntry.create({
        data: { ...providerToRow(seed, "custom", 150), createdById: actorId }
    });
    await ensureProviderCatalog(true);
    return { ok: true, slug: seed.slug };
}

/** Remove an operator-added provider. Rows from code or the index cannot be. */
export async function removeCustomProvider(slug: string): Promise<boolean> {
    const removed = await prisma.modelProviderEntry.deleteMany({
        where: { slug: slug.slice(0, 80), source: "custom" }
    });
    await ensureProviderCatalog(true);
    return removed.count > 0;
}
