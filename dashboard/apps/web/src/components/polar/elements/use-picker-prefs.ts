"use client";

/**
 * The picker's order and "Recent" group for whoever is signed in, shared by
 * every picker on the page. The last answer is drawn at once from this
 * browser's copy and read again in the background (at most every 30 s); a
 * new order shows at once and is put back if the server refuses it.
 */

import type { PickerPrefs } from "@/lib/polar/picker-order";
import { useCallback, useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "polar.picker.prefs";
const ROUTE = "/api/polar/picker";
const FRESH_MS = 30_000;
const EMPTY: PickerPrefs = { order: [], recent: [] };

let state: PickerPrefs | null = null;
let error = false;
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** An answer of the right shape, or null. */
function readable(raw: unknown): PickerPrefs | null {
    const value = raw as Partial<PickerPrefs> | null;
    return value && Array.isArray(value.order) && Array.isArray(value.recent)
        ? { order: value.order, recent: value.recent }
        : null;
}

function cached(): PickerPrefs {
    if (state) return state;
    try {
        const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? readable(JSON.parse(raw)) : null;
        if (parsed) state = parsed;
    } catch {
        // No storage: the server's answer fills it in.
    }
    return state ?? EMPTY;
}

function store(next: PickerPrefs): void {
    state = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // Kept in memory only.
    }
    emit();
}

function refresh(): void {
    if (reading || Date.now() - readAt < FRESH_MS) return;
    reading = fetch(ROUTE, { cache: "no-store" })
        .then(async (response) => {
            if (!response.ok) return;
            const answer = readable(await response.json().catch(() => null));
            if (!answer) return;
            readAt = Date.now();
            const now = cached();
            if (JSON.stringify(now) !== JSON.stringify(answer)) store(answer);
        })
        .catch(() => undefined)
        .finally(() => {
            reading = null;
        });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function usePickerPrefs(): {
    prefs: PickerPrefs;
    failed: boolean;
    setOrder: (order: readonly string[]) => void;
} {
    const prefs = useSyncExternalStore(subscribe, cached, () => EMPTY);
    const failed = useSyncExternalStore(subscribe, () => error, () => false);
    useEffect(refresh, []);
    const setOrder = useCallback((order: readonly string[]) => {
        const before = cached();
        error = false;
        store({ ...before, order: [...order] });
        void fetch(ROUTE, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ order })
        })
            .then((response) => {
                if (!response.ok) throw new Error(`${ROUTE} answered ${response.status}`);
            })
            .catch(() => {
                // Put back what the server still holds.
                error = true;
                store({ ...cached(), order: before.order });
            });
    }, []);
    return { prefs, failed, setOrder };
}

/** For tests: forget everything kept between renders. */
export function resetPickerPrefs(): void {
    state = null;
    error = false;
    readAt = 0;
    reading = null;
}
