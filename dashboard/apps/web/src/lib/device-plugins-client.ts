"use client";

/**
 * The desktop app's device plugins as the page holds them: the snapshot the
 * app answers (`polarisDesktop.plugins.get()`), read through the core schema,
 * fetched again whenever the app says something changed.
 *
 * The last snapshot is kept for the tab's lifetime, so going back to the store
 * from a plugin's page draws at once instead of waiting on the app again.
 */

import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useDesktopBridge } from "@/components/desktop-app";
import {
    pluginInstallResultSchema,
    comparePluginVersions,
    readPluginsSnapshot,
    type PluginEntry,
    type PluginPermission,
    type PluginsSnapshot,
    type InstalledPlugin
} from "@polaris/core/device-plugins";

export type PluginsBridge = NonNullable<PolarisDesktop["plugins"]>;

/** Each permission's key under `plugins.permission.*`. */
export const PERMISSION_KEY: Record<PluginPermission, string> = {
    usb: "usb",
    "audio-sessions": "audioSessions",
    display: "display",
    "polaris-actions": "polarisActions",
    network: "network"
};

/** The status sentences a plugin names (`code`) that the page says in its own language (`plugins.statusDetail.*`). */
export const PLUGIN_STATUS_SENTENCES = ["otherProgram", "noAccess", "unsupported", "stopped", "unplugged", "herculesApp", "herculesDriver", "noControls"] as const;

/** The key of the page's own sentence for a plugin's status code, or null to show the plugin's words. */
export function statusSentence(code: string | undefined): string | null {
    return code && (PLUGIN_STATUS_SENTENCES as readonly string[]).includes(code) ? `statusDetail.${code}` : null;
}

/** Where the page stands: no desktop app, an app older than plugins, waiting on it, or its answer. */
export type PluginsState =
    | { readonly kind: "browser" }
    | { readonly kind: "old-app" }
    | { readonly kind: "loading"; readonly bridge: PluginsBridge }
    | { readonly kind: "ready"; readonly bridge: PluginsBridge; readonly snapshot: PluginsSnapshot };

let lastSnapshot: PluginsSnapshot | null = null;

/** Forget the kept snapshot. For tests. */
export function resetPluginsCache(): void {
    lastSnapshot = null;
}

export function usePlugins(): PluginsState {
    const desktop = useDesktopBridge();
    // An app from before the rename answers under `addons`.
    const bridge = desktop?.plugins ?? desktop?.addons ?? null;
    const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(lastSnapshot);

    useEffect(() => {
        if (!bridge) return;
        let live = true;
        const load = () => {
            void bridge
                .get()
                .then((value) => {
                    const read = readPluginsSnapshot(value);
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

/** What a card or a page offers first for one plugin. */
export type PluginOffer =
    | { readonly kind: "install" }
    | { readonly kind: "installing"; readonly percent: number | null }
    | { readonly kind: "update"; readonly version: string }
    | { readonly kind: "installed" }
    | { readonly kind: "unavailable"; readonly reason: "platform" | "app-version"; readonly needs: string };

export function pluginOffer(snapshot: PluginsSnapshot, id: string, entry: PluginEntry | null): PluginOffer {
    const progress = snapshot.installing[id];
    if (progress) return { kind: "installing", percent: progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null };
    const installed = snapshot.installed.find((item) => item.id === id);
    if (installed?.update) return { kind: "update", version: installed.update };
    if (installed) return { kind: "installed" };
    if (!entry || !snapshot.platform || !entry.packages[snapshot.platform]) return { kind: "unavailable", reason: "platform", needs: "" };
    if (comparePluginVersions(snapshot.appVersion, entry.minAppVersion) < 0) return { kind: "unavailable", reason: "app-version", needs: entry.minAppVersion };
    return { kind: "install" };
}

/** Every plugin the store lists: the catalog's, then any installed one the catalog no longer has. */
export interface PluginListing {
    readonly id: string;
    readonly entry: PluginEntry | null;
    readonly installed: InstalledPlugin | null;
}

export function pluginListings(snapshot: PluginsSnapshot): PluginListing[] {
    const installed = new Map(snapshot.installed.map((item) => [item.id, item]));
    const listed: PluginListing[] = (snapshot.catalog?.plugins ?? []).map((entry) => ({
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

/** The store's wording for why the app refused an install. */
export function installProblem(reason: string): InstallProblem {
    switch (reason) {
        case "platform":
        case "app-version":
        case "download":
            return reason;
        case "size":
        case "hash":
        case "archive":
        case "manifest":
            return "integrity";
        default:
            return "other";
    }
}

/** How an install ended: in (and whether it started once in), or not and why. */
export type InstallOutcome = { readonly installed: true; readonly started: boolean } | { readonly installed: false; readonly problem: InstallProblem };

/** The version of one plugin the app holds right now, or null (not installed, or no answer). */
async function heldVersion(bridge: PluginsBridge, id: string): Promise<{ readonly version: string; readonly enabled: boolean } | null> {
    const snapshot = readPluginsSnapshot(await bridge.get().catch(() => null));
    const found = snapshot?.installed.find((item) => item.id === id);
    return found ? { version: found.version, enabled: found.enabled } : null;
}

/**
 * Install or update one plugin, accepting what it asks for.
 *
 * The app's answer is not the last word: an app up to 0.1.96 put the files in,
 * wrote them down as installed, and then threw while removing the version they
 * replaced (Windows keeps a loaded native module open), so the page heard an
 * error for an install that had happened. When the answer is missing or
 * unreadable, what the app now holds decides. Such an app never started the new
 * version either, so a plugin that is switched on is switched on again, which
 * has it start from the new files.
 */
export async function installPlugin(bridge: PluginsBridge, entry: PluginEntry, requires: readonly string[] = []): Promise<InstallOutcome> {
    const before = await heldVersion(bridge, entry.id);
    const answer = pluginInstallResultSchema.safeParse(await bridge.install(entry.id, entry.permissions, requires).catch(() => null));
    if (answer.success) return answer.data.ok ? { installed: true, started: answer.data.started ?? true } : { installed: false, problem: installProblem(answer.data.reason) };
    const after = await heldVersion(bridge, entry.id);
    if (!after || after.version !== entry.version || before?.version === entry.version) return { installed: false, problem: "other" };
    if (!after.enabled) return { installed: true, started: true };
    const restarted = await bridge.setEnabled(entry.id, true).catch(() => false);
    return { installed: true, started: restarted === true };
}

export function useInstallPlugin(bridge: PluginsBridge | null): (entry: PluginEntry, requires?: readonly string[]) => Promise<InstallOutcome> {
    return useCallback(async (entry: PluginEntry, requires: readonly string[] = []) => (bridge ? installPlugin(bridge, entry, requires) : { installed: false as const, problem: "other" as const }), [bridge]);
}

const officialEntrySchema = z.object({ displayName: z.string().max(300), version: z.string().max(100) });

/** What the app found of a device's official software (desktop `plugins/official.ts`, `look`). */
export const officialLookSchema = z.object({
    found: z
        .object({
            app: officialEntrySchema.nullable(),
            drivers: officialEntrySchema.nullable(),
            autostart: z.array(z.unknown()).max(100),
            running: z.boolean()
        })
        .nullable(),
    imported: z
        .object({
            pages: z.number().int().min(0).max(100),
            controls: z
                .array(
                    z.object({
                        page: z.number().int().min(0).max(100),
                        slot: z.number().int().min(0).max(100),
                        control: z.enum(["knob", "button"]),
                        official: z.string().max(300),
                        name: z.string().max(300),
                        mapped: z.object({ key: z.string().max(100), value: z.string().max(300) }).nullable(),
                        kept: z.boolean()
                    })
                )
                .max(2_000)
        })
        .nullable(),
    backup: z.object({ choice: z.enum(["stop", "uninstall", "keep"]), at: z.string().max(100), restored: z.boolean() }).nullable()
});

export type OfficialLook = z.infer<typeof officialLookSchema>;
export type OfficialControl = NonNullable<OfficialLook["imported"]>["controls"][number];

/** Every reason the app gives for not carrying a choice out (`ExecuteResult`, or `install` when the plugin did not go in). */
export const OFFICIAL_FAILURES = ["cancelled", "uninstallerRefused", "nothingToUninstall", "stopProcess", "removeAutostart", "unsigned", "declined", "uninstaller", "install", "failed"] as const;
export type OfficialFailure = (typeof OFFICIAL_FAILURES)[number];

const officialChooseSchema = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), reason: z.string().max(100), install: z.string().max(100).optional() })
]);

/** What choosing answered: done, or why not in the page's words (an unknown reason reads as `failed`). */
export type OfficialChoiceResult = { readonly ok: true } | { readonly ok: false; readonly reason: OfficialFailure; readonly install: InstallProblem | null };

export function readOfficialChoice(value: unknown): OfficialChoiceResult {
    const answer = officialChooseSchema.safeParse(value);
    if (!answer.success) return { ok: false, reason: "failed", install: null };
    if (answer.data.ok) return { ok: true };
    const reason = (OFFICIAL_FAILURES as readonly string[]).includes(answer.data.reason) ? (answer.data.reason as OfficialFailure) : "failed";
    return { ok: false, reason, install: reason === "install" ? installProblem(answer.data.install ?? "") : null };
}

export const officialRestoreSchema = z.object({
    ok: z.boolean(),
    autostart: z.number().int().min(0).max(100),
    settings: z.boolean(),
    started: z.boolean(),
    missing: z.boolean(),
    declined: z.boolean()
});

/** How putting the official app back went, as one sentence's key. */
export type OfficialRestoreOutcome = "done" | "settingsOnly" | "declined" | "failed";

export function readOfficialRestore(value: unknown): OfficialRestoreOutcome {
    const answer = officialRestoreSchema.safeParse(value);
    if (!answer.success) return "failed";
    if (answer.data.declined) return "declined";
    if (!answer.data.ok) return "failed";
    return answer.data.missing ? "settingsOnly" : "done";
}

/** What the app knows of a plugin's official software, or null for none / an app older than it / no answer. */
export async function lookOfficial(bridge: PluginsBridge | null, id: string): Promise<OfficialLook | null> {
    if (!bridge?.official) return null;
    const answer = officialLookSchema.safeParse(await bridge.official(id, { kind: "look" }).catch(() => null));
    return answer.success ? answer.data : null;
}
