"use client";

/**
 * The desktop app's device add-ons as the page holds them: the snapshot the
 * app answers (`polarisDesktop.addons.get()`), read through the core schema,
 * fetched again whenever the app says something changed.
 *
 * The last snapshot is kept for the tab's lifetime, so going back to the store
 * from an add-on's page draws at once instead of waiting on the app again.
 */

import { useCallback, useEffect, useState } from "react";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useDesktopBridge } from "@/components/desktop-app";
import {
    addonInstallResultSchema,
    compareAddonVersions,
    readAddonsSnapshot,
    type AddonEntry,
    type AddonsSnapshot,
    type InstalledAddon
} from "@polaris/core/device-addons";

export type AddonsBridge = NonNullable<PolarisDesktop["addons"]>;

/** Where the page stands: no desktop app, an app older than add-ons, waiting on it, or its answer. */
export type AddonsState =
    | { readonly kind: "browser" }
    | { readonly kind: "old-app" }
    | { readonly kind: "loading"; readonly bridge: AddonsBridge }
    | { readonly kind: "ready"; readonly bridge: AddonsBridge; readonly snapshot: AddonsSnapshot };

let lastSnapshot: AddonsSnapshot | null = null;

/** Forget the kept snapshot. For tests. */
export function resetAddonsCache(): void {
    lastSnapshot = null;
}

export function useAddons(): AddonsState {
    const desktop = useDesktopBridge();
    const bridge = desktop?.addons ?? null;
    const [snapshot, setSnapshot] = useState<AddonsSnapshot | null>(lastSnapshot);

    useEffect(() => {
        if (!bridge) return;
        let live = true;
        const load = () => {
            void bridge
                .get()
                .then((value) => {
                    const read = readAddonsSnapshot(value);
                    if (!live || !read) return;
                    lastSnapshot = read;
                    setSnapshot(read);
                })
                .catch(() => undefined);
        };
        load();
        const stop = bridge.onChange(load);
        return () => {
            live = false;
            stop();
        };
    }, [bridge]);

    if (!desktop) return { kind: "browser" };
    if (!bridge) return { kind: "old-app" };
    return snapshot ? { kind: "ready", bridge, snapshot } : { kind: "loading", bridge };
}

/** What a card or a page offers first for one add-on. */
export type AddonOffer =
    | { readonly kind: "install" }
    | { readonly kind: "installing"; readonly percent: number | null }
    | { readonly kind: "update"; readonly version: string }
    | { readonly kind: "installed" }
    | { readonly kind: "unavailable"; readonly reason: "platform" | "app-version"; readonly needs: string };

export function addonOffer(snapshot: AddonsSnapshot, id: string, entry: AddonEntry | null): AddonOffer {
    const progress = snapshot.installing[id];
    if (progress) return { kind: "installing", percent: progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null };
    const installed = snapshot.installed.find((item) => item.id === id);
    if (installed?.update) return { kind: "update", version: installed.update };
    if (installed) return { kind: "installed" };
    if (!entry || !snapshot.platform || !entry.packages[snapshot.platform]) return { kind: "unavailable", reason: "platform", needs: "" };
    if (compareAddonVersions(snapshot.appVersion, entry.minAppVersion) < 0) return { kind: "unavailable", reason: "app-version", needs: entry.minAppVersion };
    return { kind: "install" };
}

/** Every add-on the store lists: the catalog's, then any installed one the catalog no longer has. */
export interface AddonListing {
    readonly id: string;
    readonly entry: AddonEntry | null;
    readonly installed: InstalledAddon | null;
}

export function addonListings(snapshot: AddonsSnapshot): AddonListing[] {
    const installed = new Map(snapshot.installed.map((item) => [item.id, item]));
    const listed: AddonListing[] = (snapshot.catalog?.addons ?? []).map((entry) => ({
        id: entry.id,
        entry,
        installed: installed.get(entry.id) ?? null
    }));
    const known = new Set(listed.map((item) => item.id));
    for (const item of snapshot.installed) if (!known.has(item.id)) listed.push({ id: item.id, entry: null, installed: item });
    return listed;
}

/** Why an install did not happen, as the store words it. */
export type InstallProblem = "platform" | "app-version" | "download" | "integrity" | "other";

/** Install or update one add-on, accepting what it asks for; null when it went in. */
export function useInstallAddon(bridge: AddonsBridge | null): (entry: AddonEntry) => Promise<InstallProblem | null> {
    return useCallback(
        async (entry: AddonEntry) => {
            if (!bridge) return "other";
            const answer = addonInstallResultSchema.safeParse(await bridge.install(entry.id, entry.permissions).catch(() => null));
            if (!answer.success) return "other";
            if (answer.data.ok) return null;
            switch (answer.data.reason) {
                case "platform":
                case "app-version":
                case "download":
                    return answer.data.reason;
                case "size":
                case "hash":
                case "archive":
                case "manifest":
                    return "integrity";
                default:
                    return "other";
            }
        },
        [bridge]
    );
}
