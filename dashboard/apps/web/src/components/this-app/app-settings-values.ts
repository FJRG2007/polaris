"use client";

/**
 * The values a Settings > This app screen draws, kept so the screen never waits
 * on the app to answer before it shows them.
 *
 * Three places, freshest first: the answer the app gave this session (shared by
 * every category, so moving between them swaps nothing), the last answer kept on
 * this device for the category being opened (`localStorage`, so a reload or the
 * next start of the app draws the switches where they were), and only then
 * nothing - a value this device has never seen, which the screen shows as a
 * placeholder on that one control. The app is asked in the background every
 * time, and the screen changes only where its answer differs.
 *
 * A change shows at once and is put back, with a toast, when the app refuses it.
 * Used by every category; screens of their own under This app (hosts, add-ons)
 * read through the same hook rather than asking the bridge themselves.
 */

import { useToast } from "@polaris/ui";
import * as core from "@polaris/core/app-settings";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DesktopAppSettings = NonNullable<PolarisDesktop["appSettings"]>;

/** The answer the app gave this session, whichever category asked. */
let liveSnapshot: core.AppSettingsSnapshot | null = null;

const STORE_PREFIX = "polaris.this-app.";

/** Only for tests: forget the session's answer (the device's kept ones stay in `localStorage`). */
export function forgetAppSettingsSnapshot(): void {
    liveSnapshot = null;
}

function storeKey(category: string): string {
    return `${STORE_PREFIX}${category}`;
}

/** Whether two answers would draw the same screen, so an identical one changes nothing. */
function same<T>(a: T | null, b: T): boolean {
    return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Where a This app screen keeps what the app answered: this session's copy
 * (`session`, which several screens may share) and this device's (`localStorage`
 * under `key`, read through `parse` because it may be from an older build).
 */
export interface KeptAnswerStore<T> {
    session: T | null;
    readonly key: string;
    readonly parse: (raw: unknown) => T | null;
}

/** The answer a screen draws first: this session's, else the one kept on the device. */
export function keptAnswer<T>(store: KeptAnswerStore<T>): T | null {
    if (store.session) return store.session;
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(store.key);
        return raw ? store.parse(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

export interface KeptAnswer<T> {
    /** Null only while this device has never seen an answer. */
    readonly value: T | null;
    /** The app did not answer and nothing is kept to draw instead. */
    readonly unavailable: boolean;
    /** Ask the app again. */
    readonly refresh: () => Promise<void>;
    /** Take an answer: drawn now, and kept for the session and on the device. */
    readonly keep: (next: T) => void;
}

/**
 * Draws the kept answer at once and asks the app in the background - on mount,
 * when it says something changed (`subscribe`), and when the window comes back
 * - changing the screen only where the answer differs. `onAnswer` hears every
 * fresh answer, for what a screen fills in after (a host's status).
 */
export function useKeptAnswer<T>(
    store: KeptAnswerStore<T>,
    ask: () => Promise<unknown>,
    options: { subscribe?: (listener: () => void) => () => void; onAnswer?: (value: T) => void } = {}
): KeptAnswer<T> {
    const [value, setValue] = useState<T | null>(() => keptAnswer(store));
    const [unavailable, setUnavailable] = useState(false);
    // Read through refs, so a caller's inline functions never ask the app again on every render.
    const latest = useRef({ store, ask, ...options });
    latest.current = { store, ask, ...options };

    const keep = useCallback((next: T) => {
        const { store: kept } = latest.current;
        kept.session = next;
        try {
            window.localStorage.setItem(kept.key, JSON.stringify(next));
        } catch {
            // A private window or a full store: the session's copy still holds.
        }
        setValue((current) => (same(current, next) ? current : next));
    }, []);

    const refresh = useCallback(async () => {
        const { store: kept, ask: request, onAnswer } = latest.current;
        const next = kept.parse(await request().catch(() => null));
        if (next) {
            keep(next);
            setUnavailable(false);
            onAnswer?.(next);
        } else if (!keptAnswer(kept)) setUnavailable(true);
    }, [keep]);

    const key = store.key;
    useEffect(() => {
        void refresh();
        const stop = latest.current.subscribe?.(() => void refresh());
        const visible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        const focused = () => void refresh();
        window.addEventListener("focus", focused);
        document.addEventListener("visibilitychange", visible);
        return () => {
            stop?.();
            window.removeEventListener("focus", focused);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [refresh, key]);

    return { value, unavailable, refresh, keep };
}

/** Where a category's answer is kept: the session's is every category's, the device's is the category's own. */
function categoryStore(category: string): KeptAnswerStore<core.AppSettingsSnapshot> {
    return {
        get session() {
            return liveSnapshot;
        },
        set session(next) {
            liveSnapshot = next;
        },
        key: storeKey(category),
        parse: core.readAppSettings
    };
}

export interface AppSettingsValues {
    /** Null only while this device has never seen an answer for the category. */
    readonly snapshot: core.AppSettingsSnapshot | null;
    /** The app did not answer and nothing is kept to draw instead. */
    readonly unavailable: boolean;
    /** Ask the app again. */
    readonly refresh: () => Promise<void>;
    /** Show a change now; put it back when the app refuses it. */
    readonly change: (next: core.AppSettingChange) => void;
    /** Take an answer the app gave elsewhere (a recorded shortcut). */
    readonly keep: (next: core.AppSettingsSnapshot) => void;
}

export function useAppSettingsValues(settings: DesktopAppSettings, category: string): AppSettingsValues {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const store = useMemo(() => categoryStore(category), [category]);
    const { value: snapshot, unavailable, refresh, keep } = useKeptAnswer(store, () => settings.get(), {
        subscribe: (listener) => settings.onChange(listener)
    });

    const change = useCallback(
        (next: core.AppSettingChange) => {
            const before = keptAnswer(store);
            if (!before || before[next.key] === next.value) return;
            keep({ ...before, [next.key]: next.value });
            void settings
                .set(next)
                .catch(() => null)
                .then((answer) => {
                    const after = core.readAppSettings(answer);
                    if (after) return keep(after);
                    keep(before);
                    toast.show({ title: t("saveFailed") });
                });
        },
        [settings, keep, toast, t, store]
    );

    return { snapshot, unavailable, refresh, change, keep };
}
