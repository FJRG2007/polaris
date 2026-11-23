/**
 * Device add-ons on this computer: the catalog, what is installed, what runs.
 *
 * Costs nothing until used: with nothing installed no file but `installed.json`
 * is read, no process starts and nothing is fetched - the catalog is fetched
 * when the store is opened, or, where plugs can be heard, to offer support for a
 * device that was just plugged in. Pure of Electron (the process, the fetch and
 * the notice are given), for the tests.
 */

import { join } from "node:path";
import type { Fetcher } from "./catalog";
import type { AddonMethod } from "@/shared/addon-protocol";
import type { TrustedKey } from "./signature";
import { cachedCatalog, refreshCatalog, CATALOG_URL } from "./catalog";
import { createSupervisor, type AddonChild, type AddonRun, type WantedAddon } from "./supervisor";
import {
    addonDevicePresent,
    addonFit,
    addonsClaiming,
    compareAddonVersions,
    readAddonSettingChange,
    type AddonCatalog,
    type AddonEntry,
    type AddonManifest,
    type AddonPermission,
    type AddonPlatform,
    type AddonSettingValue,
    type UsbDevice
} from "@polaris/core/device-addons";
import {
    installAddon,
    installedManifest,
    packageDir,
    readAddonSettings,
    readInstalled,
    setAddonEnabled,
    uninstallAddon,
    writeAddonSettings,
    type InstallFailure
} from "./packages";

/** How long a catalog on the device is used before a read refreshes it in the background. */
export const CATALOG_FRESH_MS = 6 * 60 * 60_000;

export interface ManagerOptions {
    readonly dir: string;
    readonly platform: AddonPlatform | null;
    readonly appVersion: string;
    readonly fetcher: Fetcher;
    readonly fork: (wanted: WantedAddon) => AddonChild;
    readonly call: (id: string, method: AddonMethod, params: unknown) => Promise<unknown>;
    /** Devices plugged in now, or null where that cannot be known (presence.ts). */
    readonly devices: () => UsbDevice[] | null;
    /** A device a catalog add-on supports was plugged in and the add-on is not installed. */
    readonly offer?: (entry: AddonEntry, deviceName: string) => void;
    readonly onChange?: () => void;
    readonly log?: (id: string, level: "info" | "warn" | "error", text: string) => void;
    readonly catalogUrl?: string;
    readonly keys?: readonly TrustedKey[];
    readonly now?: () => number;
}

export interface InstalledView {
    readonly id: string;
    readonly version: string;
    readonly enabled: boolean;
    readonly granted: readonly AddonPermission[];
    readonly manifest: AddonManifest | null;
    /** The catalog's newer version, when there is one this app can install. */
    readonly update: string | null;
    /** Running, or why not: "disabled", "sleeping" (its device is unplugged) or "missing" (its files are gone). */
    readonly run: AddonRun | { readonly state: "disabled" | "sleeping" | "missing"; };
}

export interface AddonsSnapshot {
    readonly platform: AddonPlatform | null;
    readonly appVersion: string;
    readonly catalog: AddonCatalog | null;
    readonly installed: readonly InstalledView[];
    readonly installing: Readonly<Record<string, { readonly received: number; readonly total: number; }>>;
}

export function createAddonManager(options: ManagerOptions) {
    const now = options.now ?? Date.now;
    const changed = () => options.onChange?.();
    const supervisor = createSupervisor({ fork: options.fork, call: options.call, onChange: changed, log: options.log });
    let catalog: AddonCatalog | null = null;
    let catalogRead = false;
    let fetchedAt = 0;
    let refreshing: Promise<void> | null = null;
    const installing: Record<string, { received: number; total: number; }> = {};
    const manifests = new Map<string, AddonManifest | null>();
    const offered = new Set<string>();
    let busy: Promise<unknown> = Promise.resolve();

    /** One change to the installed set at a time, in order. */
    function serial<T>(work: () => Promise<T>): Promise<T> {
        const next = busy.then(work, work);
        busy = next.catch(() => undefined);
        return next;
    }

    async function loadCatalog(): Promise<void> {
        if (!catalogRead) {
            catalogRead = true;
            catalog = catalog ?? (await cachedCatalog(options.dir, options.keys));
        }
    }

    function revalidate(): Promise<void> {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            await loadCatalog();
            const result = await refreshCatalog(options.dir, options.fetcher, catalog, options.catalogUrl ?? CATALOG_URL, options.keys);
            if (result.kind !== "failed") fetchedAt = now();
            if (result.kind === "updated") {
                catalog = result.catalog;
                changed();
            }
        })().finally(() => {
            refreshing = null;
        });
        return refreshing;
    }

    async function manifestOf(id: string, version: string): Promise<AddonManifest | null> {
        const key = `${id}@${version}`;
        if (!manifests.has(key)) manifests.set(key, await installedManifest(options.dir, id, version));
        return manifests.get(key) ?? null;
    }

    /** Start what is installed, enabled and has its device; stop the rest. */
    async function reconcile(): Promise<void> {
        const installed = await readInstalled(options.dir);
        const devices = options.devices();
        if (devices) supervisor.devices(devices);
        for (const id of supervisor.running()) if (!installed.addons[id]?.enabled) supervisor.drop(id);
        for (const [id, addon] of Object.entries(installed.addons)) {
            const manifest = addon.enabled ? await manifestOf(id, addon.version) : null;
            const entry = manifest && options.platform ? manifest.entries[options.platform] : undefined;
            if (!manifest || !entry || (devices && !addonDevicePresent(manifest, devices))) {
                supervisor.drop(id);
                continue;
            }
            supervisor.want({
                manifest,
                granted: addon.granted,
                entryPath: join(packageDir(options.dir, id, addon.version), ...entry.split("/")),
                settings: await readAddonSettings(options.dir, manifest)
            });
        }
        changed();
    }

    return {
        /** Start what should run. Reads `installed.json` only. */
        start: () => serial(reconcile),

        /** The devices changed: wake or put to sleep what claims them, and offer what is not installed. */
        async devicesChanged(devices: readonly UsbDevice[]): Promise<void> {
            await serial(reconcile);
            if (!options.offer) return;
            await loadCatalog();
            if (!catalog || now() - fetchedAt > CATALOG_FRESH_MS) await revalidate().catch(() => undefined);
            if (!catalog) return;
            const installed = await readInstalled(options.dir);
            for (const { entry, claim } of addonsClaiming(catalog, devices)) {
                if (installed.addons[entry.id] || offered.has(entry.id) || !addonFit(entry, options.platform, options.appVersion).ok) continue;
                offered.add(entry.id);
                options.offer(entry, claim.name);
            }
        },

        /** Everything a store screen draws, at once from what is on the device; a stale catalog is refreshed behind it. */
        async snapshot(): Promise<AddonsSnapshot> {
            await loadCatalog();
            if (now() - fetchedAt > CATALOG_FRESH_MS) void revalidate().catch(() => undefined);
            const installed = await readInstalled(options.dir);
            const devices = options.devices();
            const runs = supervisor.snapshot();
            const views: InstalledView[] = [];
            for (const [id, addon] of Object.entries(installed.addons)) {
                const manifest = await manifestOf(id, addon.version);
                const entry = catalog?.addons.find((item) => item.id === id);
                const update =
                    entry && compareAddonVersions(entry.version, addon.version) > 0 && addonFit(entry, options.platform, options.appVersion).ok ? entry.version : null;
                const run: InstalledView["run"] = !manifest
                    ? { state: "missing" }
                    : !addon.enabled
                      ? { state: "disabled" }
                      : (runs[id] ?? (devices && !addonDevicePresent(manifest, devices) ? { state: "sleeping" } : { state: "missing" }));
                views.push({ id, version: addon.version, enabled: addon.enabled, granted: addon.granted, manifest, update, run });
            }
            return { platform: options.platform, appVersion: options.appVersion, catalog, installed: views, installing: { ...installing } };
        },

        /** Refresh the catalog now, as the store's "check for updates" does. */
        refresh: () => revalidate(),

        install(id: string, accepted: readonly AddonPermission[]): Promise<{ ok: true; } | { ok: false; reason: InstallFailure | "unknown"; }> {
            return serial(async () => {
                await loadCatalog();
                const entry = catalog?.addons.find((item) => item.id === id);
                if (!entry) return { ok: false as const, reason: "unknown" as const };
                installing[id] = { received: 0, total: 0 };
                changed();
                try {
                    const result = await installAddon({
                        dir: options.dir,
                        entry,
                        platform: options.platform,
                        appVersion: options.appVersion,
                        accepted,
                        fetcher: options.fetcher,
                        onProgress: (received, total) => {
                            installing[id] = { received, total };
                            changed();
                        }
                    });
                    if (!result.ok) return result;
                    supervisor.drop(id);
                    await reconcile();
                    return { ok: true as const };
                } finally {
                    delete installing[id];
                    changed();
                }
            });
        },

        uninstall(id: string): Promise<void> {
            return serial(async () => {
                supervisor.drop(id);
                await uninstallAddon(options.dir, id);
                for (const key of [...manifests.keys()]) if (key.startsWith(`${id}@`)) manifests.delete(key);
                await reconcile();
            });
        },

        setEnabled(id: string, enabled: boolean): Promise<boolean> {
            return serial(async () => {
                const found = await setAddonEnabled(options.dir, id, enabled);
                if (found) await reconcile();
                return found;
            });
        },

        async settings(id: string): Promise<Record<string, AddonSettingValue> | null> {
            const addon = (await readInstalled(options.dir)).addons[id];
            const manifest = addon ? await manifestOf(id, addon.version) : null;
            return manifest ? readAddonSettings(options.dir, manifest) : null;
        },

        /** Change one setting; answers every value after it, or null when the key or value does not fit. */
        setSetting(id: string, key: unknown, value: unknown): Promise<Record<string, AddonSettingValue> | null> {
            return serial(async () => {
                const addon = (await readInstalled(options.dir)).addons[id];
                const manifest = addon ? await manifestOf(id, addon.version) : null;
                if (!manifest) return null;
                const change = readAddonSettingChange(manifest.settings, key, value);
                if (!change) return null;
                const values = { ...(await readAddonSettings(options.dir, manifest)), [change.key]: change.value };
                await writeAddonSettings(options.dir, id, values);
                supervisor.settings(id, values);
                changed();
                return values;
            });
        },

        stop: () => supervisor.stopAll()
    };
}

export type AddonManager = ReturnType<typeof createAddonManager>;
