"use client";

/**
 * The device add-ons the search lists, from wherever this page can learn them:
 * the desktop app it runs in (`polarisDesktop.addons`), the desktop launcher
 * window hosting the palette (`SearchHost.addons`), or - with neither, in a
 * plain browser - the published catalog alone (`/api/addons/catalog`), so only
 * add-ons to install are listed there.
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
import { addonEntries, ADDONS_HREF } from "@/lib/search/addon-entries";
import { readAddonCatalog, readAddonsSnapshot, type AddonCatalog, type InstalledAddon } from "@polaris/core/device-addons";

interface AddonSource {
    readonly installed: readonly InstalledAddon[] | null;
    readonly catalog: AddonCatalog | null;
}

const CATALOG_KEY = "polaris:search:addon-catalog";
let lastSource: AddonSource | null = null;

/** Forget the kept answer. For tests. */
export function resetAddonEntriesCache(): void {
    lastSource = null;
}

function storedCatalog(): AddonCatalog | null {
    try {
        const raw = window.sessionStorage.getItem(CATALOG_KEY);
        return raw ? readAddonCatalog(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function storeCatalog(catalog: AddonCatalog | null): void {
    try {
        if (catalog) window.sessionStorage.setItem(CATALOG_KEY, JSON.stringify(catalog));
    } catch {
        // A private window or blocked storage: the copy in memory still serves this tab.
    }
}

async function ask(desktop: (() => Promise<unknown>) | null): Promise<AddonSource | null> {
    if (desktop) {
        const snapshot = readAddonsSnapshot(await desktop());
        return snapshot ? { installed: snapshot.installed, catalog: snapshot.catalog } : null;
    }
    // The route says how long its answer keeps; the browser holds it that long.
    const response = await fetch("/api/addons/catalog");
    if (!response.ok) return null;
    const body = (await response.json()) as { catalog?: unknown };
    const catalog = body.catalog == null ? null : readAddonCatalog(body.catalog);
    storeCatalog(catalog);
    return { installed: null, catalog };
}

function sameSource(a: AddonSource | null, b: AddonSource): boolean {
    return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function useAddonEntries(open: boolean, host: SearchHost | undefined): CommandEntry[] {
    const t = useTranslations("components");
    const locale = useLocale();
    const bridge = useDesktopBridge()?.addons ?? null;
    const [source, setSource] = useState<AddonSource | null>(lastSource);

    useEffect(() => {
        if (!open) return;
        const desktop = bridge ? () => bridge.get() : (host?.addons ?? null);
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
        const entries = addonEntries(
            { installed: source.installed, catalog: source.catalog, locale },
            {
                installed: t("search.addons.installed"),
                catalog: t("search.addons.catalog"),
                setting: (name) => t("search.addons.setting", { name }),
                section: (name) => t("search.addons.section", { name }),
                offer: (publisher, summary) => t("search.addons.offer", { publisher, summary }),
                keywords: [t("search.addons.installed"), "add-on", "addon", "plugin"]
            }
        );
        // The store itself, where the desktop app is known to be: the launcher
        // window has no app settings of its own, so its rail-derived pages lack it.
        if (source.installed !== null) {
            entries.unshift({
                id: "addon-store",
                label: t("search.addons.installed"),
                group: t("search.addons.installed"),
                href: ADDONS_HREF,
                icon: Puzzle,
                keywords: [t("search.addons.installed"), "add-on", "addon", "plugin", "usb"]
            });
        }
        return entries;
    }, [source, locale, t]);
}
