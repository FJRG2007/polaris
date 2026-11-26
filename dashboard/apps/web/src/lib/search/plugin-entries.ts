/**
 * Device plugins as search entries: each one installed on this device, its
 * page and every setting it declares, and the catalog's others as plugins to
 * install.
 *
 * What is installed is known only to the desktop app on the device, so the
 * caller passes its snapshot; a page with no desktop app behind it passes the
 * published catalog alone, and only the plugins to install are listed. Pure,
 * so the entries can be asserted in a test.
 */

import type { CommandEntry } from "./entries";
import { Download, Puzzle, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { pluginSettingTargets, type PluginCatalog, type PluginManifest, type InstalledPlugin } from "@polaris/core/device-plugins";

/** The store's own page, which every plugin page sits under. */
export const PLUGINS_HREF = "/account/plugins";

/** The reader's words for what the entries are listed under. */
export interface PluginSearchWords {
    /** Heading of the plugins installed here ("Device plugins"). */
    readonly installed: string;
    /** Heading of the catalog's others ("Plugins to install"). */
    readonly catalog: string;
    /** Second line of a setting ("Setting of {name}"). */
    readonly setting: (name: string) => string;
    /** Second line of a group of settings ("Settings of {name}"). */
    readonly section: (name: string) => string;
    /** Second line of a plugin to install ("By {publisher} - {summary}"). */
    readonly offer: (publisher: string, summary: string) => string;
    /** Terms that find any plugin ("plugin", "plugin" in the reader's language). */
    readonly keywords: readonly string[];
}

export interface PluginSearchSource {
    /** What the desktop app has installed; null when there is no desktop app to ask. */
    readonly installed: readonly InstalledPlugin[] | null;
    readonly catalog: PluginCatalog | null;
    readonly locale: string;
}

export function pluginHref(id: string): string {
    return `${PLUGINS_HREF}/${encodeURIComponent(id)}`;
}

function claimNames(manifest: Pick<PluginManifest, "claims">): string[] {
    return manifest.claims.map((claim) => claim.name);
}

export function pluginEntries(source: PluginSearchSource, words: PluginSearchWords): CommandEntry[] {
    const entries: CommandEntry[] = [];
    const listed = new Map((source.catalog?.plugins ?? []).map((entry) => [entry.id, entry]));
    const installedIds = new Set<string>();

    for (const plugin of source.installed ?? []) {
        installedIds.add(plugin.id);
        // The files on the device first; the catalog's copy when they are no longer read.
        const manifest = plugin.manifest ?? listed.get(plugin.id) ?? null;
        if (!manifest) continue;
        const href = pluginHref(plugin.id);
        entries.push({
            id: `plugin:${plugin.id}`,
            label: manifest.name,
            group: words.installed,
            href,
            icon: Puzzle,
            context: manifest.summary,
            keywords: [...words.keywords, manifest.publisher, ...claimNames(manifest)]
        });
        // A setting is only drawn once the plugin's own files are read.
        if (!plugin.manifest) continue;
        for (const target of pluginSettingTargets(plugin.manifest, source.locale)) {
            const group = target.kind === "group";
            entries.push({
                id: `plugin-${target.kind}:${plugin.id}:${target.key}`,
                label: target.section ? `${manifest.name} - ${target.section} - ${target.label}` : `${manifest.name} - ${target.label}`,
                group: words.installed,
                href: `${href}#${target.anchor}`,
                icon: group ? LayoutGrid : SlidersHorizontal,
                context: group ? words.section(manifest.name) : words.setting(manifest.name),
                keywords: [target.label, ...(target.section ? [target.section] : []), ...target.words]
            });
        }
    }

    for (const entry of source.catalog?.plugins ?? []) {
        if (installedIds.has(entry.id)) continue;
        entries.push({
            id: `plugin-offer:${entry.id}`,
            label: entry.name,
            group: words.catalog,
            href: pluginHref(entry.id),
            icon: Download,
            context: words.offer(entry.publisher, entry.summary),
            keywords: [...words.keywords, entry.category, ...claimNames(entry)]
        });
    }
    return entries;
}
