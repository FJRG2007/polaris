"use client";

/**
 * The records and views somebody pinned inside an app, for that app's rail.
 *
 * The rail is drawn by the shell, which knows the app from the path and
 * nothing else, so it asks - once per app, keeping the answer for the tab so
 * moving between the app's screens never blinks the rail. The app says when
 * its favorites changed (`refreshAppFavorites`), and the rail asks again.
 */

import { useEffect, useState } from "react";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

export interface AppFavoriteItem {
    readonly id: string;
    readonly label: string;
    readonly href: string;
}

const MAX_AGE_MS = 30 * 60_000;
const CHANGED = "polaris:app-favorites";

const key = (appId: string) => `app.favorites:${appId}`;

/** Tell the rail an app's favorites changed. */
export function refreshAppFavorites(appId: string): void {
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: appId }));
}

/** The answer, kept to well-formed items that stay inside the dashboard. */
export function readFavoriteItems(body: unknown): AppFavoriteItem[] {
    const list = (body as { favorites?: unknown } | null)?.favorites;
    if (!Array.isArray(list)) return [];
    return list.filter(
        (item): item is AppFavoriteItem =>
            typeof item?.id === "string" &&
            typeof item?.label === "string" &&
            typeof item?.href === "string" &&
            item.href.startsWith("/") &&
            !item.href.startsWith("//")
    );
}

export function useAppFavorites(appId: string | null): AppFavoriteItem[] {
    const [items, setItems] = useState<AppFavoriteItem[]>(() =>
        appId ? (readSnapshot<AppFavoriteItem[]>(key(appId), MAX_AGE_MS)?.value ?? []) : []
    );

    useEffect(() => {
        if (!appId) {
            setItems([]);
            return;
        }
        setItems(readSnapshot<AppFavoriteItem[]>(key(appId), MAX_AGE_MS)?.value ?? []);
        let controller = new AbortController();
        const load = () => {
            controller.abort();
            controller = new AbortController();
            void fetch(`/api/apps/favorites?app=${encodeURIComponent(appId)}`, {
                cache: "no-store",
                signal: controller.signal
            })
                .then(async (response) => {
                    if (!response.ok) return;
                    const value = readFavoriteItems(await response.json());
                    setItems(value);
                    writeSnapshot(key(appId), value);
                })
                .catch(() => {
                    // Offline: the rail keeps what it last had.
                });
        };
        const onChanged = (event: Event) => {
            if ((event as CustomEvent<string>).detail === appId) load();
        };
        load();
        window.addEventListener(CHANGED, onChanged);
        return () => {
            controller.abort();
            window.removeEventListener(CHANGED, onChanged);
        };
    }, [appId]);

    return items;
}
