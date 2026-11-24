/**
 * Device add-ons as search entries: each one installed on this device, its
 * page and every setting it declares, and the catalog's others as add-ons to
 * install.
 *
 * What is installed is known only to the desktop app on the device, so the
 * caller passes its snapshot; a page with no desktop app behind it passes the
 * published catalog alone, and only the add-ons to install are listed. Pure,
 * so the entries can be asserted in a test.
 */

import type { CommandEntry } from "./entries";
import { Download, Puzzle, SlidersHorizontal } from "lucide-react";
import { addonText, type AddonCatalog, type AddonManifest, type InstalledAddon } from "@polaris/core/device-addons";

/** The store's own page, which every add-on page sits under. */
export const ADDONS_HREF = "/account/addons";

/** The reader's words for what the entries are listed under. */
export interface AddonSearchWords {
    /** Heading of the add-ons installed here ("Device add-ons"). */
    readonly installed: string;
    /** Heading of the catalog's others ("Add-ons to install"). */
    readonly catalog: string;
    /** Second line of a setting ("Setting of {name}"). */
    readonly setting: (name: string) => string;
    /** Second line of an add-on to install ("By {publisher} - {summary}"). */
    readonly offer: (publisher: string, summary: string) => string;
    /** Terms that find any add-on ("add-on", "plugin" in the reader's language). */
    readonly keywords: readonly string[];
}

export interface AddonSearchSource {
    /** What the desktop app has installed; null when there is no desktop app to ask. */
    readonly installed: readonly InstalledAddon[] | null;
    readonly catalog: AddonCatalog | null;
    readonly locale: string;
}

export function addonHref(id: string): string {
    return `${ADDONS_HREF}/${encodeURIComponent(id)}`;
}

/** Where one setting is drawn on its add-on's page (the row's `id`). */
export function addonSettingAnchor(key: string): string {
    return `setting-${key}`;
}

function claimNames(manifest: Pick<AddonManifest, "claims">): string[] {
    return manifest.claims.map((claim) => claim.name);
}

export function addonEntries(source: AddonSearchSource, words: AddonSearchWords): CommandEntry[] {
    const entries: CommandEntry[] = [];
    const listed = new Map((source.catalog?.addons ?? []).map((entry) => [entry.id, entry]));
    const installedIds = new Set<string>();

    for (const addon of source.installed ?? []) {
        installedIds.add(addon.id);
        // The files on the device first; the catalog's copy when they are no longer read.
        const manifest = addon.manifest ?? listed.get(addon.id) ?? null;
        if (!manifest) continue;
        const href = addonHref(addon.id);
        entries.push({
            id: `addon:${addon.id}`,
            label: manifest.name,
            group: words.installed,
            href,
            icon: Puzzle,
            context: manifest.summary,
            keywords: [...words.keywords, manifest.publisher, ...claimNames(manifest)]
        });
        // A setting is only drawn once the add-on's own files are read.
        for (const setting of addon.manifest?.settings ?? []) {
            const label = addonText(setting.label, source.locale);
            const options = setting.kind === "choice" ? setting.options.map((option) => addonText(option.label, source.locale)) : [];
            entries.push({
                id: `addon-setting:${addon.id}:${setting.key}`,
                label: `${manifest.name} - ${label}`,
                group: words.installed,
                href: `${href}#${addonSettingAnchor(setting.key)}`,
                icon: SlidersHorizontal,
                context: words.setting(manifest.name),
                keywords: [label, ...(setting.hint ? [addonText(setting.hint, source.locale)] : []), ...options]
            });
        }
    }

    for (const entry of source.catalog?.addons ?? []) {
        if (installedIds.has(entry.id)) continue;
        entries.push({
            id: `addon-offer:${entry.id}`,
            label: entry.name,
            group: words.catalog,
            href: addonHref(entry.id),
            icon: Download,
            context: words.offer(entry.publisher, entry.summary),
            keywords: [...words.keywords, entry.category, ...claimNames(entry)]
        });
    }
    return entries;
}
