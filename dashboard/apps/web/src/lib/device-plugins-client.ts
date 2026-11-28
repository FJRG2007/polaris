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
import { useCallback, useEffect, useRef, useState } from "react";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useDesktopBridge } from "@/components/desktop-app";
import {
    pluginInstallResultSchema,
    comparePluginVersions,
    readPluginsSnapshot,
    pluginStatusText,
    readPluginSettingValues,
    type PluginEntry,
    type PluginSetting,
    type PluginSettingValue,
    type PluginManifest,
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

/**
 * The status sentences any plugin may name (`code`) that the page says in its own
 * language (`plugins.statusDetail.*`, with the device's name as `{device}`). What
 * only one plugin knows about its device it says itself, in its manifest's
 * `statusTexts`: no plugin's words live here, so a plugin release never makes
 * the dashboard publish an update.
 */
export const PLUGIN_STATUS_SENTENCES = ["otherProgram", "noAccess", "unsupported", "stopped", "unplugged", "noControls"] as const;

/** The key of the page's own sentence for a plugin's status code, or null to show the plugin's words. */
export function statusSentence(code: string | undefined): string | null {
    return code && (PLUGIN_STATUS_SENTENCES as readonly string[]).includes(code) ? `statusDetail.${code}` : null;
}

/**
 * The sentence a running plugin's status shows: the plugin's own words in the
 * reader's language (the installed version's, then the catalog's newer one), the
 * page's sentence for a shared code, or the plugin's English `detail`.
 */
export function statusDetail(
    status: { readonly code?: string; readonly detail?: string },
    manifests: readonly (PluginManifest | null | undefined)[],
    locale: string,
    say: (key: string, values: { device: string }) => string
): string | undefined {
    const own = pluginStatusText(manifests, status.code, locale);
    if (own) return own;
    const sentence = statusSentence(status.code);
    const device = manifests.find(Boolean)?.name;
    return sentence && device ? say(sentence, { device }) : status.detail;
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

/**
 * A plugin's stored settings as the page last read them, per id and installed
 * version, so its settings draw at once on the next visit (stale while
 * revalidate): kept for the tab in memory and, for the next page load, in this
 * browser's storage; read again from the app in the background, and swapped in
 * only when they differ. A version that changed reads as nothing kept, since
 * its settings may not be the same ones.
 */
export type PluginSettingValues = Record<string, PluginSettingValue>;

const SETTINGS_STORE = "polaris.plugin-settings.v1:";
const keptSettings = new Map<string, { readonly version: string; readonly values: PluginSettingValues; readonly said: string }>();
const settingsListeners = new Map<string, Set<() => void>>();
/** A local change counts up, so a read that began before it cannot put the old values back. */
const settingsWrites = new Map<string, number>();
const settingsReads = new Map<string, Promise<void>>();
const settingsAgain = new Set<string>();

function storedSettings(id: string, version: string): PluginSettingValues | null {
    try {
        const raw = window.localStorage.getItem(`${SETTINGS_STORE}${id}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { version?: unknown; values?: unknown };
        if (parsed.version !== version || !parsed.values || typeof parsed.values !== "object") return null;
        return parsed.values as PluginSettingValues;
    } catch {
        return null;
    }
}

/** The values kept for this id and version, or null when none are. */
export function cachedPluginSettings(id: string, version: string, settings?: readonly PluginSetting[]): PluginSettingValues | null {
    const kept = keptSettings.get(id);
    if (kept) return kept.version === version ? kept.values : null;
    const stored = typeof window === "undefined" ? null : storedSettings(id, version);
    if (!stored) return null;
    // What storage gave back is read like the app's answer: only the declared settings, each of its own kind.
    const values = settings ? readPluginSettingValues(settings, stored) : stored;
    keptSettings.set(id, { version, values, said: JSON.stringify(values) });
    return values;
}

/** Keep `values` for this id and version; tells whoever draws them only when they changed. True when they did. */
export function keepPluginSettings(id: string, version: string, values: PluginSettingValues): boolean {
    const said = JSON.stringify(values);
    const kept = keptSettings.get(id);
    if (kept && kept.version === version && kept.said === said) return false;
    keptSettings.set(id, { version, values, said });
    try {
        window.localStorage.setItem(`${SETTINGS_STORE}${id}`, JSON.stringify({ version, values }));
    } catch {
        // Storage is a convenience: without it the next page load reads the app first.
    }
    for (const listener of settingsListeners.get(id) ?? []) listener();
    return true;
}

/** A change made on this page: kept at once, and any read already under way no longer counts. */
export function changePluginSettings(id: string, version: string, values: PluginSettingValues): void {
    settingsWrites.set(id, (settingsWrites.get(id) ?? 0) + 1);
    keepPluginSettings(id, version, values);
}

/**
 * Read the stored values from the app and keep them. One read per plugin at a
 * time: everyone asking meanwhile shares it. A read a local change overtook is
 * dropped (the change's own answer is the newer one).
 */
export function refreshPluginSettings(bridge: Pick<PluginsBridge, "settings">, id: string, version: string, settings: readonly PluginSetting[]): Promise<void> {
    const running = settingsReads.get(id);
    if (running) {
        // Asked during a read: what changed may be newer than it, so one more read follows it.
        settingsAgain.add(id);
        return running;
    }
    const writes = settingsWrites.get(id) ?? 0;
    const read = bridge
        .settings(id)
        .then((stored) => {
            if (stored && (settingsWrites.get(id) ?? 0) === writes) keepPluginSettings(id, version, readPluginSettingValues(settings, stored));
        })
        .catch(() => undefined)
        .finally(() => {
            settingsReads.delete(id);
            if (settingsAgain.delete(id)) void refreshPluginSettings(bridge, id, version, settings);
        });
    settingsReads.set(id, read);
    return read;
}

/** Forget every kept value. For tests. */
export function resetPluginSettingsCache(): void {
    keptSettings.clear();
    settingsListeners.clear();
    settingsWrites.clear();
    settingsReads.clear();
    settingsAgain.clear();
}

/**
 * One plugin's stored settings: what was kept at once (null only on a first
 * visit), read again in the background on mount and whenever the app says
 * something changed. Keyed on the id and version, never on the manifest
 * object, which is a new one after every change the app announces.
 */
export function usePluginSettings(bridge: PluginsBridge, manifest: Pick<PluginManifest, "id" | "version" | "settings">): PluginSettingValues | null {
    const { id, version } = manifest;
    const declared = useRef(manifest.settings);
    declared.current = manifest.settings;
    const [values, setValues] = useState<PluginSettingValues | null>(() => cachedPluginSettings(id, version, manifest.settings));

    useEffect(() => {
        const follow = () => setValues(cachedPluginSettings(id, version, declared.current));
        follow();
        const listeners = settingsListeners.get(id) ?? new Set<() => void>();
        settingsListeners.set(id, listeners);
        listeners.add(follow);
        return () => {
            listeners.delete(follow);
        };
    }, [id, version]);

    useEffect(() => {
        const read = () => void refreshPluginSettings(bridge, id, version, declared.current);
        read();
        return bridge.onChange ? bridge.onChange(read) : undefined;
    }, [bridge, id, version]);

    return values;
}

/** What a card or a page offers first for one plugin. */
export type PluginOffer =
    | { readonly kind: "install" }
    /** `updating`: a version is already installed, so the card says "Updating". */
    | { readonly kind: "installing"; readonly percent: number | null; readonly updating: boolean }
    | { readonly kind: "update"; readonly version: string }
    | { readonly kind: "installed" }
    | { readonly kind: "unavailable"; readonly reason: "platform" | "app-version"; readonly needs: string };

export function pluginOffer(snapshot: PluginsSnapshot, id: string, entry: PluginEntry | null): PluginOffer {
    const progress = snapshot.installing[id];
    const installed = snapshot.installed.find((item) => item.id === id);
    if (progress) return { kind: "installing", percent: progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null, updating: Boolean(installed) };
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
export type InstallProblem = "platform" | "app-version" | "download" | "integrity" | "timeout" | "other";

/** The store's wording for why the app refused an install. */
export function installProblem(reason: string): InstallProblem {
    switch (reason) {
        case "platform":
        case "app-version":
        case "download":
        case "timeout":
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
    backup: z.object({ choice: z.enum(["stop", "uninstall", "keep"]), at: z.string().max(100), restored: z.boolean() }).nullable(),
    /** Polaris' own driver holds the device, so the official app is not needed for it. False from an app older than it. */
    driverInUse: z.boolean().catch(false)
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

const pluginLiveSchema = z.object({
    knobs: z.array(z.object({ label: z.string().max(80), volume: z.number().int().min(0).max(100).nullable(), muted: z.boolean() })).max(8)
});

/** What a running plugin's device shows now: each knob's name, volume and mute. */
export type PluginLive = z.infer<typeof pluginLiveSchema>;

/** A live value from the desktop app, checked, or null for anything else. */
export function readPluginLive(value: unknown): PluginLive | null {
    const parsed = pluginLiveSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/**
 * The device's live values while the page is open: the newest the app holds
 * at once, then every change it pushes. Null from an app older than them, or
 * before the device has shown anything.
 */
export function usePluginLive(bridge: Pick<PluginsBridge, "live" | "onLive"> | null, id: string): PluginLive | null {
    const [live, setLive] = useState<PluginLive | null>(null);
    useEffect(() => {
        if (!bridge?.onLive) return;
        let current = true;
        const stop = bridge.onLive((from, value) => {
            if (from !== id) return;
            const read = readPluginLive(value);
            if (read) setLive(read);
        });
        void bridge
            .live?.(id)
            .catch(() => null)
            .then((value) => {
                const read = readPluginLive(value);
                // A push that landed first is newer than this read.
                if (current && read) setLive((held) => held ?? read);
            });
        return () => {
            current = false;
            stop();
        };
    }, [bridge, id]);
    return live;
}
