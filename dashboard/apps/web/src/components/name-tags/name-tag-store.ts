"use client";

/**
 * The name tags of everybody drawn on screen, asked for together.
 *
 * A name asks for its person's tag; the ids are gathered for one tick and sent
 * as one request, so a list of fifty names is one lookup rather than fifty. An
 * answer is kept for a minute and drawn at once while it is asked again, so a
 * screen coming back shows the tag it had instead of drawing it late.
 */

import { useEffect, useSyncExternalStore } from "react";
import * as core from "@polaris/core";

const GATHER_MS = 60;
const FRESH_MS = 60_000;

const known = new Map<string, { tag: core.NameTagView | null; at: number }>();
const waiting = new Set<string>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
    for (const listener of listeners) listener();
}

async function ask(ids: string[]): Promise<void> {
    try {
        const response = await fetch("/api/profile/name-tags", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids })
        });
        if (!response.ok) return;
        const body = (await response.json()) as { tags?: Record<string, core.NameTagView> };
        const at = Date.now();
        for (const id of ids) known.set(id, { tag: body.tags?.[id] ?? null, at });
        emit();
    } catch {
        // Left unknown, so the next draw asks again.
    } finally {
        for (const id of ids) asking.delete(id);
    }
}

function flush(): void {
    timer = null;
    const ids = [...waiting];
    waiting.clear();
    for (let start = 0; start < ids.length; start += core.NAME_TAG_LOOKUP_MAX)
        void ask(ids.slice(start, start + core.NAME_TAG_LOOKUP_MAX));
}

function want(id: string): void {
    const held = known.get(id);
    if ((held && Date.now() - held.at < FRESH_MS) || asking.has(id) || waiting.has(id)) return;
    waiting.add(id);
    asking.add(id);
    timer ??= setTimeout(flush, GATHER_MS);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Drop what is kept - after somebody changes the tag they wear. */
export function forgetNameTags(): void {
    known.clear();
    emit();
}

/** This person's tag as the viewer may see it, or null. */
export function useNameTag(id: string | null | undefined): core.NameTagView | null {
    useEffect(() => {
        if (id) want(id);
    }, [id]);
    return useSyncExternalStore(
        subscribe,
        () => (id ? (known.get(id)?.tag ?? null) : null),
        () => null
    );
}
