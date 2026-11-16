/**
 * OpenCode Zen's free models, for a person who has no key of their own.
 *
 * Ported from OpenCode's own provider (`packages/core/src/plugin/provider/
 * opencode.ts`, the `apiKey: "public"` transform and the model transform after
 * it): with no Zen account, OpenCode calls Zen with the literal key `public`
 * and hides every model that has an input price. Polaris does the same, under
 * its own slug (`ZEN_FREE_SLUG`) so the anonymous tier never passes for a
 * person's own Zen key.
 *
 * The list is Zen's own (`/zen/v1/models`), which carries each model's price
 * and the address that serves it, read with a short cache: a reader is answered
 * from the last list at once and the list is refreshed behind it, so only the
 * very first read on a fresh process waits, and that wait is bounded.
 *
 * Every entry is held to a schema, one at a time: an entry Zen reshapes is
 * dropped rather than taking the whole list with it, and a model with no
 * price, a price above zero, or no chat-completions address is never offered.
 *
 * Server-only.
 */

import { z } from "zod";
import { ZEN_FREE_SLUG } from "@/lib/polar/shared";
import type { ChatCredential } from "@/lib/agents/model-keys";
import type { PolarModelOption, PolarProviderOption } from "@/lib/polar/models";

/** The endpoint OpenCode's provider uses with the public key. */
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/** The key OpenCode sends when nobody signed in (`opencode.ts`). */
export const ZEN_PUBLIC_KEY = "public";

/** The brand, as the provider is named outside the picker (which labels it
 *  through its own messages). */
export const ZEN_FREE_NAME = "OpenCode Zen"; // i18n-ignore: brand name

/** How long a fetched list is fresh, and how long a failed read waits before
 *  the next attempt. */
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;

/** How long one read of the list may take. */
const LIST_TIMEOUT_MS = 5_000;

/** Most bytes of list read: the whole catalogue is about 100 KB today. */
const LIST_MAX_BYTES = 2 * 1024 * 1024;

const priceSchema = z.object({ price: z.number().nonnegative() });

const zenModelSchema = z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    type: z.string().optional(),
    release_date: z.string().max(40).optional(),
    modalities: z.object({ input: z.array(z.string().max(80)).max(100) }).partial().optional(),
    capabilities: z
        .object({
            tools: z.object({ supported: z.boolean() }).partial(),
            reasoning: z.object({ supported: z.boolean() }).partial()
        })
        .partial()
        .optional(),
    limit: z
        .object({ context: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
        .partial()
        .optional(),
    cost: z.object({
        text: z.object({ input: priceSchema, output: priceSchema.optional() })
    }),
    api: z.object({
        "chat-completions": z.object({ base_url: z.string().url() })
    })
});

const zenListSchema = z.object({ data: z.array(z.unknown()).max(2000) });

/** One free model, as the picker and the client need it. */
export interface ZenModel {
    id: string;
    name: string;
    contextTokens: number;
    outputTokens: number;
    reasoning: boolean;
    attachment: boolean;
    inputs: string[];
    releaseDate: string | null;
    baseUrl: string;
}

/** Only an https address on OpenCode's own host is called: the list names the
 *  address, and a list is not a reason to send anything anywhere else. */
function ownAddress(value: string): string | null {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== "opencode.ai") return null;
        return url.href.replace(/\/+$/, "");
    } catch {
        return null;
    }
}

/** Modalities as the catalogue words them ("image/png" -> "image"). */
function modalities(raw: readonly string[]): string[] {
    return [...new Set(raw.map((entry) => entry.split("/")[0]!).filter(Boolean))];
}

/**
 * The free, tool-calling chat models in one `/zen/v1/models` answer. Pure.
 * A priced model is left out exactly as OpenCode leaves it out: any input
 * price above zero; an output price above zero is left out too, since a model
 * that bills its answers is not free either.
 */
export function freeZenModels(payload: unknown): ZenModel[] {
    const list = zenListSchema.safeParse(payload);
    if (!list.success) return [];
    const models: ZenModel[] = [];
    for (const raw of list.data.data) {
        const parsed = zenModelSchema.safeParse(raw);
        if (!parsed.success) continue;
        const entry = parsed.data;
        if (entry.type !== undefined && entry.type !== "chat") continue;
        if (entry.cost.text.input.price > 0 || (entry.cost.text.output?.price ?? 0) > 0) continue;
        if (entry.capabilities?.tools?.supported === false) continue;
        const baseUrl = ownAddress(entry.api["chat-completions"].base_url);
        if (!baseUrl) continue;
        const inputs = modalities(entry.modalities?.input ?? []);
        models.push({
            id: entry.id,
            name: entry.name ?? entry.id,
            contextTokens: entry.limit?.context ?? 0,
            outputTokens: entry.limit?.output ?? 0,
            reasoning: entry.capabilities?.reasoning?.supported === true,
            attachment: inputs.some((input) => input !== "text"),
            inputs,
            releaseDate: entry.release_date ?? null,
            baseUrl
        });
    }
    return models;
}

/** How the list is read. The real one is a bounded fetch; a test hands in its own. */
export type ZenListReader = () => Promise<unknown>;

async function readList(): Promise<unknown> {
    const response = await fetch(`${ZEN_BASE_URL}/models`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        redirect: "error"
    });
    if (!response.ok) throw new Error(`zen models: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > LIST_MAX_BYTES) throw new Error("zen models: answer too large");
    return JSON.parse(text);
}

interface ListCache {
    models: ZenModel[];
    /** When the list may be read again. */
    until: number;
    pending: Promise<ZenModel[]> | null;
    read: boolean;
}

let cache: ListCache = { models: [], until: 0, pending: null, read: false };
let reader: ZenListReader = readList;

/** For tests: a reader in place of the network, and a cold cache. */
export function resetZenCache(next: ZenListReader = readList): void {
    cache = { models: [], until: 0, pending: null, read: false };
    reader = next;
}

function refresh(now: number): Promise<ZenModel[]> {
    cache.pending ??= reader()
        .then((payload) => {
            const models = freeZenModels(payload);
            cache = { models, until: now + FRESH_MS, pending: null, read: true };
            return models;
        })
        .catch((error: unknown) => {
            console.warn("polar: could not read OpenCode Zen's models", error);
            // The last good list keeps serving; the next read tries again soon.
            cache = { ...cache, until: now + RETRY_MS, pending: null, read: true };
            return cache.models;
        });
    return cache.pending;
}

/** The free models on offer now: the remembered list, refreshed behind the
 *  reader once stale; only a process that never read one waits for it. */
export async function zenFreeModels(now = Date.now()): Promise<ZenModel[]> {
    if (!cache.read) return refresh(now);
    if (now >= cache.until) void refresh(now);
    return cache.models;
}

/** The address one model is served at, from the remembered list. */
export function zenBaseUrl(model: string): string {
    return cache.models.find((entry) => entry.id === model)?.baseUrl ?? ZEN_BASE_URL;
}

/** The free tier as one provider in Polar's catalogue. Pure. */
export function zenProviderOption(models: readonly ZenModel[]): PolarProviderOption {
    return {
        provider: ZEN_FREE_SLUG,
        name: ZEN_FREE_NAME,
        payers: ["instance"],
        models: models.map(
            (model): PolarModelOption => ({
                provider: ZEN_FREE_SLUG,
                providerName: ZEN_FREE_NAME,
                model: model.id,
                name: model.name,
                reasoning: model.reasoning,
                attachment: model.attachment,
                contextTokens: model.contextTokens,
                outputTokens: model.outputTokens,
                providerContextTokens: null,
                costInput: 0,
                costOutput: 0,
                inputs: model.inputs,
                releaseDate: model.releaseDate
            })
        )
    };
}

/** The credential a call to the free tier spends: nobody's, the public key. */
export function zenCredential(): ChatCredential {
    return {
        provider: ZEN_FREE_SLUG,
        source: "instance",
        secret: ZEN_PUBLIC_KEY,
        baseUrl: null,
        gatewayModel: null
    };
}
