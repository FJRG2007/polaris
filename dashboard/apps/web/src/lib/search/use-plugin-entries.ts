"use client";

/**
 * The device plugins the search lists, from wherever this page can learn them:
 * the desktop app it runs in (`polarisDesktop.plugins`), the desktop launcher
 * window hosting the palette (`SearchHost.plugins`), or - with neither, in a
 * plain browser - the published catalog alone (`/api/plugins/catalog`), so only
 * plugins to install are listed there.
 *
 * Asked each time the search opens, never before: the last answer is kept for
 * the tab's lifetime (and the catalog in sessionStorage), so the entries are
 * there at once and swapped only when the fresh answer differs.
 */

import { Puzzle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { CommandEntry } from "@/lib/search/entries";
import type { SearchHost } from "@/lib/search/search-host";
import { useDesktopBridge } from "@/components/desktop-app";
import { pluginEntries, PLUGINS_HREF } from "@/lib/search/plugin-entries";
import { readPluginCatalog, readPluginsSnapshot, type PluginCatalog, type InstalledPlugin } from "@polaris/core/device-plugins";

interface PluginSource {
    readonly installed: readonly InstalledPlugin[] | null;
    readonly catalog: PluginCatalog | null;
}

const CATALOG_KEY = "polaris:search:plugin-catalog";
let lastSource: PluginSource | null = null;

/** Forget the kept answer. For tests. */
export function resetPluginEntriesCache(): void {
    lastSource = null;
}

function storedCatalog(): PluginCatalog | null {
    try {
        const raw = window.sessionStorage.getItem(CATALOG_KEY);
        return raw ? readPluginCatalog(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function storeCatalog(catalog: PluginCatalog | null): void {
    try {
        if (catalog) window.sessionStorage.setItem(CATALOG_KEY, JSON.stringify(catalog));
    } catch {
        // A private window or blocked storage: the copy in memory still serves this tab.
    }
}

async function ask(desktop: (() => Promise<unknown>) | null): Promise<PluginSource | null> {
    if (desktop) {
        const snapshot = readPluginsSnapshot(await desktop());
        return snapshot ? { installed: snapshot.installed, catalog: snapshot.catalog } : null;
    }
    // The route says how long its answer keeps; the browser holds it that long.
    const response = await fetch("/api/plugins/catalog");
    if (!response.ok) return null;
    const body = (await response.json()) as { catalog?: unknown };
    const catalog = body.catalog == null ? null : readPluginCatalog(body.catalog);
    storeCatalog(catalog);
    return { installed: null, catalog };
}

function sameSource(a: PluginSource | null, b: PluginSource): boolean {
    return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function usePluginEntries(open: boolean, host: SearchHost | undefined): CommandEntry[] {
    const t = useTranslations("components");
    const locale = useLocale();
    const bridge = useDesktopBridge()?.plugins ?? null;
    const [source, setSource] = useState<PluginSource | null>(lastSource);

    useEffect(() => {
        if (!open) return;
        const desktop = bridge ? () => bridge.get() : (host?.plugins ?? null);
        if (!desktop && !lastSource) {
            const kept = storedCatalog();
            if (kept) setSource((lastSource = { installed: null, catalog: kept }));
        }
        let live = true;
        void ask(desktop)
            .then((next) => {
                if (!live || !next || sameSource(lastSource, next)) return;
                lastSource = next;
                setSource(next);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [open, bridge, host]);

    return useMemo(() => {
        if (!source) return [];
        const entries = pluginEntries(
            { installed: source.installed, catalog: source.catalog, locale },
            {
                installed: t("search.plugins.installed"),
                catalog: t("search.plugins.catalog"),
                setting: (name) => t("search.plugins.setting", { name }),
                section: (name) => t("search.plugins.section", { name }),
                offer: (publisher, summary) => t("search.plugins.offer", { publisher, summary }),
                keywords: ["add-on", "addon", "plugin"]
            }
        );
        // The store itself, where the desktop app is known to be: the launcher
        // window has no app settings of its own, so its rail-derived pages lack it.
        if (source.installed !== null) {
            entries.unshift({
                id: "plugin-store",
                label: t("search.plugins.installed"),
                group: t("search.plugins.installed"),
                href: PLUGINS_HREF,
                icon: Puzzle,
                keywords: ["add-on", "addon", "plugin", "usb"]
            });
        }
        return entries;
    }, [source, locale, t]);
}
