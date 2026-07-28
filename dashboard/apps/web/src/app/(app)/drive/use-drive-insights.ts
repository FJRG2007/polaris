"use client";

/**
 * Folder weights and archive locks for the folder on screen. Neither can be read
 * from a directory entry, so they load after the listing and fill in behind it -
 * the file table is never held back waiting for a subtree walk.
 *
 * The server answers with what it finished plus the folders it did not get to;
 * this asks again for those, each round starting from the cache the last one
 * left, until nothing is pending or the rounds run out. Results are kept briefly
 * in memory so stepping back into a folder shows its weights immediately instead
 * of measuring them again.
 */

import { useEffect, useState } from "react";

export interface FolderWeight {
    readonly bytes: bigint;
    readonly files: number;
    readonly folders: number;
    /** A gated subtree was skipped, so this is a floor rather than the total. */
    readonly partial: boolean;
}

export interface DriveInsights {
    /** Measured weight per sub-folder path. */
    readonly sizes: ReadonlyMap<string, FolderWeight>;
    /** Paths of archives that need a password. */
    readonly locked: ReadonlySet<string>;
    /** Sub-folders still being measured. */
    readonly pending: ReadonlySet<string>;
}

const EMPTY: DriveInsights = { sizes: new Map(), locked: new Set(), pending: new Set() };

/** Follow-up rounds before giving up on the folders still being measured. */
const MAX_ROUNDS = 12;
/** Pause between rounds, so a slow backend is not hammered. */
const RETRY_MS = 600;
/** How long a result is reused when the same folder is opened again. */
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; insights: DriveInsights }>();
/** Folders remembered at once; a write mints a new key, so this stays bounded. */
const CACHE_LIMIT = 50;

function remember(key: string, insights: DriveInsights): void {
    cache.set(key, { at: Date.now(), insights });
    if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
}

interface InsightsResponse {
    sizes?: Record<string, { bytes: string; files: number; folders: number; partial: boolean }>;
    archives?: Record<string, boolean>;
    pending?: string[];
}

/** Fold one response into what previous rounds already measured. */
function merge(previous: DriveInsights, body: InsightsResponse): DriveInsights {
    const sizes = new Map(previous.sizes);
    for (const [path, size] of Object.entries(body.sizes ?? {})) {
        sizes.set(path, {
            bytes: BigInt(size.bytes),
            files: size.files,
            folders: size.folders,
            partial: size.partial
        });
    }
    const locked = new Set(previous.locked);
    for (const [path, isLocked] of Object.entries(body.archives ?? {})) {
        if (isLocked) locked.add(path);
    }
    return { sizes, locked, pending: new Set(body.pending ?? []) };
}

/**
 * `revision` is a signature of the listing (names, sizes, times). It changes when
 * a write lands, which is exactly when the weights on screen stop being true - so
 * it belongs in the key as well as the dependencies, or an upload would keep
 * showing the folder's weight from before it.
 */
export function useDriveInsights(
    connectionId: string,
    path: string,
    enabled: boolean,
    revision: string
): DriveInsights {
    const [insights, setInsights] = useState<DriveInsights>(EMPTY);

    useEffect(() => {
        if (!enabled) {
            setInsights(EMPTY);
            return;
        }
        const key = `${connectionId}|${path}|${revision}`;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS && hit.insights.pending.size === 0) {
            setInsights(hit.insights);
            return;
        }
        setInsights(hit?.insights ?? EMPTY);

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let current = hit?.insights ?? EMPTY;
        let round = 0;

        const run = async () => {
            const query = new URLSearchParams({ c: connectionId });
            if (path) query.set("p", path);
            try {
                const response = await fetch(`/api/drive/insights?${query.toString()}`, {
                    signal: controller.signal
                });
                if (!response.ok) return;
                const body = (await response.json()) as InsightsResponse;
                if (controller.signal.aborted) return;
                current = merge(current, body);
                remember(key, current);
                setInsights(current);
                if (current.pending.size > 0 && ++round < MAX_ROUNDS) {
                    timer = setTimeout(() => void run(), RETRY_MS);
                }
            } catch {
                // Weights are an enhancement; a failure leaves the listing as it is.
            }
        };
        void run();

        return () => {
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [connectionId, path, enabled, revision]);

    return insights;
}
