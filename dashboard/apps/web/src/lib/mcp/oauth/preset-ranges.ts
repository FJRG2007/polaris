/**
 * The address ranges a connection exception's preset names, read from where
 * the vendor publishes them.
 *
 * OpenAI publishes the ranges ChatGPT's connectors, actions and apps call from
 * at https://openai.com/chatgpt-connectors.json (documented at
 * https://developers.openai.com/api/docs/guides/ip-addresses), and says they
 * change: the list is fetched, kept for a few hours and fetched again, so a
 * connection allowed by it follows OpenAI rather than a copy that goes stale.
 *
 * A failed fetch keeps the last list that was read; with none read yet the
 * preset matches nothing. It only ever widens a rule, so not knowing the list
 * must not let anything through.
 */

import { z } from "zod";
import { isCidr } from "@polaris/core";
import type { ExceptionPreset } from "./network-exception";
import { configuredRequest, readCapped } from "@/lib/safe-fetch";

export const PRESET_SOURCES: Record<ExceptionPreset, string> = {
    openai: "https://openai.com/chatgpt-connectors.json"
};

/** How long a list read is trusted before it is fetched again. */
const FRESH_MS = 6 * 60 * 60 * 1000;
/** How long a failed fetch waits before the next try, so a call is not a fetch. */
const RETRY_MS = 5 * 60 * 1000;
/** The published file is a few kilobytes; anything near this is not it. */
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;

const listSchema = z.object({
    prefixes: z
        .array(
            z.object({
                ipv4Prefix: z.string().max(64).optional(),
                ipv6Prefix: z.string().max(64).optional()
            })
        )
        .max(10_000)
});

interface Entry {
    ranges: readonly string[];
    readAt: number;
    triedAt: number;
    pending: Promise<void> | null;
}

const cache = new Map<ExceptionPreset, Entry>();

/** The ranges in a published list; anything that is not a CIDR is skipped. */
export function parsePresetList(body: unknown): string[] | null {
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) return null;
    const ranges = parsed.data.prefixes
        .map((prefix) => prefix.ipv4Prefix ?? prefix.ipv6Prefix ?? "")
        .filter((range) => isCidr(range));
    return ranges.length > 0 ? ranges : null;
}

async function fetchList(preset: ExceptionPreset): Promise<string[] | null> {
    try {
        const response = await configuredRequest(
            PRESET_SOURCES[preset],
            { timeoutMs: TIMEOUT_MS, headers: { accept: "application/json" } },
            { allowPrivate: false }
        );
        if (!response.ok) return null;
        // configuredRequest hands back undici's response typed as the
        // platform's; readCapped reads it by its undici declaration.
        const bytes = await readCapped(
            response as unknown as Parameters<typeof readCapped>[0],
            MAX_BYTES
        );
        if (!bytes) return null;
        return parsePresetList(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        return null;
    }
}

/** The ranges a preset names now, fetched when the copy held is old. */
export async function presetRanges(preset: ExceptionPreset): Promise<readonly string[]> {
    const now = Date.now();
    let entry = cache.get(preset);
    if (!entry) {
        entry = { ranges: [], readAt: 0, triedAt: 0, pending: null };
        cache.set(preset, entry);
    }
    const stale = now - entry.readAt > FRESH_MS;
    if (stale && now - entry.triedAt > RETRY_MS && !entry.pending) {
        const held = entry;
        held.triedAt = now;
        held.pending = fetchList(preset).then((ranges) => {
            if (ranges) {
                held.ranges = ranges;
                held.readAt = Date.now();
            }
            held.pending = null;
        });
    }
    // A list already held answers at once while a newer one is read; only the
    // very first read is waited for.
    if (entry.pending && entry.ranges.length === 0) await entry.pending;
    return entry.ranges;
}

/** Forget what was read. For tests. */
export function clearPresetRanges(): void {
    cache.clear();
}
