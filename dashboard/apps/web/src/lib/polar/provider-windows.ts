/**
 * The context window each model has, in the provider's own words, for the
 * providers whose API says so. Anything else falls back to the catalogue's
 * figure (models.dev `limit.context`), and a model neither knows gets no bar.
 *
 * - Anthropic: GET https://api.anthropic.com/v1/models lists every model with
 *   `max_input_tokens` ("Maximum input context window size in tokens"),
 *   up to 1000 a page (https://platform.claude.com/docs/en/api/models/list).
 * - Gemini: GET https://generativelanguage.googleapis.com/v1beta/models lists
 *   each model as `models/<id>` with `inputTokenLimit`, up to 1000 a page with
 *   `nextPageToken` (https://ai.google.dev/api/models); the key goes in the
 *   `x-goog-api-key` header (https://ai.google.dev/gemini-api/docs/api-key).
 *
 * One list call per provider and key, kept in memory for a few hours: a
 * window changes with a model release, not between turns. A call that fails
 * is remembered briefly so a provider that is down is not asked on every
 * request, and never fails the picker. Server-only.
 */

import { createHash } from "node:crypto";
import type { ChatCredential } from "@/lib/agents/model-keys";

/** The providers whose API reports a window. */
export const WINDOW_PROVIDERS = ["anthropic", "google-ai"] as const;

const ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models?limit=1000";
const GEMINI_MODELS = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
/** The Messages API version every Anthropic request names. */
const ANTHROPIC_VERSION = "2023-06-01";

const KEPT_MS = 6 * 60 * 60 * 1000;
const FAILED_KEPT_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 3000;
/** Gemini pages read at most; a page holds up to 1000 models. */
const GEMINI_PAGES = 3;
/** Keys remembered at most, so a busy instance's memory stays bounded. */
const KEPT_MOST = 200;

type Windows = ReadonlyMap<string, number>;

const kept = new Map<string, { windows: Windows; until: number }>();
/** Lists being read now, so one key is never asked twice at once. */
const reading = new Map<string, Promise<Windows>>();

function positive(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

/** Model id -> window from an Anthropic models page. */
export function anthropicWindows(body: unknown): Map<string, number> {
    const windows = new Map<string, number>();
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return windows;
    for (const entry of data as { id?: unknown; max_input_tokens?: unknown }[]) {
        const window = positive(entry?.max_input_tokens);
        if (typeof entry?.id === "string" && window) windows.set(entry.id, window);
    }
    return windows;
}

/** Model id (without `models/`) -> window from a Gemini models page. */
export function geminiWindows(body: unknown): Map<string, number> {
    const windows = new Map<string, number>();
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) return windows;
    for (const entry of models as { name?: unknown; inputTokenLimit?: unknown }[]) {
        const window = positive(entry?.inputTokenLimit);
        if (typeof entry?.name === "string" && window) {
            windows.set(entry.name.replace(/^models\//, ""), window);
        }
    }
    return windows;
}

async function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`models list answered ${response.status}`);
    return response.json();
}

async function listWindows(provider: string, secret: string): Promise<Windows> {
    if (provider === "anthropic") {
        return anthropicWindows(
            await readJson(ANTHROPIC_MODELS, {
                "x-api-key": secret,
                "anthropic-version": ANTHROPIC_VERSION
            })
        );
    }
    const windows = new Map<string, number>();
    let token: string | null = null;
    for (let page = 0; page < GEMINI_PAGES; page++) {
        const body = (await readJson(
            token ? `${GEMINI_MODELS}&pageToken=${encodeURIComponent(token)}` : GEMINI_MODELS,
            { "x-goog-api-key": secret }
        )) as { nextPageToken?: unknown };
        for (const [id, window] of geminiWindows(body)) windows.set(id, window);
        token = typeof body?.nextPageToken === "string" ? body.nextPageToken : null;
        if (!token) break;
    }
    return windows;
}

async function refresh(key: string, provider: string, secret: string): Promise<Windows> {
    let windows: Windows;
    let until: number;
    try {
        windows = await listWindows(provider, secret);
        until = Date.now() + KEPT_MS;
    } catch {
        windows = new Map();
        until = Date.now() + FAILED_KEPT_MS;
    }
    kept.delete(key);
    if (kept.size >= KEPT_MOST) {
        const oldest = kept.keys().next().value;
        if (oldest !== undefined) kept.delete(oldest);
    }
    kept.set(key, { windows, until });
    return windows;
}

/**
 * The windows a provider reports for the models this key reaches; empty when
 * the provider reports none, or could not be asked. Never throws.
 *
 * A remembered list is answered at once, even past its time, while a fresh
 * one is read in the background. With nothing remembered, `wait` reads it
 * now; without it the answer is empty and the list arrives for the next call,
 * so a chat turn never waits on a provider's model list.
 */
export async function providerWindows(
    credential: Pick<ChatCredential, "provider" | "secret"> | null,
    options: { wait?: boolean; now?: number } = {}
): Promise<Windows> {
    if (!credential?.secret) return new Map();
    if (!(WINDOW_PROVIDERS as readonly string[]).includes(credential.provider)) return new Map();
    const now = options.now ?? Date.now();
    const key = `${credential.provider}:${createHash("sha256").update(credential.secret).digest("hex")}`;
    const hit = kept.get(key);
    if (hit && hit.until > now) return hit.windows;
    let pending = reading.get(key);
    if (!pending) {
        pending = refresh(key, credential.provider, credential.secret).finally(() =>
            reading.delete(key)
        );
        reading.set(key, pending);
    }
    if (hit) return hit.windows;
    return options.wait ? pending : new Map();
}

/** Test seam: forget every remembered list. */
export function forgetProviderWindows(): void {
    kept.clear();
    reading.clear();
}
