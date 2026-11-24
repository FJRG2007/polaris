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
import { useCallback, useEffect, useState } from "react";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useTranslations } from "@/components/i18n/i18n-provider";

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

/** The last answer kept on this device for a category, read through the schema: it may be from an older build. */
export function readKeptAppSettings(category: string): core.AppSettingsSnapshot | null {
    try {
        const raw = window.localStorage.getItem(storeKey(category));
        return raw ? core.readAppSettings(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function keepOnDevice(category: string, snapshot: core.AppSettingsSnapshot): void {
    try {
        window.localStorage.setItem(storeKey(category), JSON.stringify(snapshot));
    } catch {
        // A private window or a full store: the session's copy still holds.
    }
}

/** What the category draws first: this session's answer, else the one kept on the device. */
function firstSnapshot(category: string): core.AppSettingsSnapshot | null {
    if (liveSnapshot) return liveSnapshot;
    if (typeof window === "undefined") return null;
    return readKeptAppSettings(category);
}

/** Whether two answers would draw the same screen, so an identical one changes nothing. */
function same(a: core.AppSettingsSnapshot | null, b: core.AppSettingsSnapshot): boolean {
    return !!a && JSON.stringify(a) === JSON.stringify(b);
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
    const [snapshot, setSnapshot] = useState<core.AppSettingsSnapshot | null>(() => firstSnapshot(category));
    const [unavailable, setUnavailable] = useState(false);

    const keep = useCallback(
        (next: core.AppSettingsSnapshot) => {
            liveSnapshot = next;
            keepOnDevice(category, next);
            setSnapshot((current) => (same(current, next) ? current : next));
        },
        [category]
    );

    const refresh = useCallback(async () => {
        const next = core.readAppSettings(await settings.get().catch(() => null));
        if (next) {
            keep(next);
            setUnavailable(false);
        } else if (!liveSnapshot && !readKeptAppSettings(category)) setUnavailable(true);
    }, [settings, keep, category]);

    useEffect(() => {
        void refresh();
        const stop = settings.onChange(() => void refresh());
        const visible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        const focused = () => void refresh();
        window.addEventListener("focus", focused);
        document.addEventListener("visibilitychange", visible);
        return () => {
            stop();
            window.removeEventListener("focus", focused);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [settings, refresh]);

    const change = useCallback(
        (next: core.AppSettingChange) => {
            const before = liveSnapshot ?? readKeptAppSettings(category);
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
        [settings, keep, toast, t, category]
    );

    return { snapshot, unavailable, refresh, change, keep };
}
