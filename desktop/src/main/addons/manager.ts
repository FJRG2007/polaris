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
import { addedPermissions, announced, autoUpdates, decideUpdate, FIRST_CHECK_MS, nextCheckDelay, type UpdateNews } from "./updates";
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
    rollbackAddon,
    setAddonEnabled,
    updateInstalled,
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
    /** Tell the person about an update: put in, waiting for them, or rolled back. Once per version. */
    readonly notify?: (id: string, news: UpdateNews) => void;
    /** Run `work` after `ms`; answers how to cancel it. A real timer by default. */
    readonly later?: (work: () => void, ms: number) => () => void;
    /** The timer a crashed add-on is restarted on (the supervisor's own by default). For the tests. */
    readonly restartTimer?: (run: () => void, ms: number) => unknown;
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
    /** Its own automatic-update choice; null follows the setting for every add-on. */
    readonly autoUpdate: boolean | null;
    /** The permissions `update` asks for that were not accepted: it waits for the person while any are. */
    readonly consent: readonly AddonPermission[];
    /** A version that failed here and was rolled back from. */
    readonly failed: string | null;
    /** Running, or why not: "disabled", "sleeping" (its device is unplugged) or "missing" (its files are gone). */
    readonly run: AddonRun | { readonly state: "disabled" | "sleeping" | "missing"; };
}

export interface AddonsSnapshot {
    readonly platform: AddonPlatform | null;
    readonly appVersion: string;
    readonly catalog: AddonCatalog | null;
    /** Whether updates go in by themselves, for every add-on without a choice of its own. */
    readonly autoUpdate: boolean;
    readonly installed: readonly InstalledView[];
    readonly installing: Readonly<Record<string, { readonly received: number; readonly total: number; }>>;
}

function realTimer(work: () => void, ms: number): () => void {
    const timer = setTimeout(work, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
}

export function createAddonManager(options: ManagerOptions) {
    const now = options.now ?? Date.now;
    const later = options.later ?? realTimer;
    const changed = () => options.onChange?.();
    /** A run changed: roll back a version that keeps failing, and put in an update that waited on a busy add-on. */
    const runChanged = () => {
        changed();
        void afterRunChange();
    };
    const supervisor = createSupervisor({
        fork: options.fork,
        call: options.call,
        onChange: runChanged,
        log: options.log,
        ...(options.restartTimer ? { setTimer: options.restartTimer } : {})
    });
    let catalog: AddonCatalog | null = null;
    let catalogRead = false;
    let fetchedAt = 0;
    let refreshing: Promise<void> | null = null;
    const installing: Record<string, { received: number; total: number; }> = {};
    const manifests = new Map<string, AddonManifest | null>();
    const offered = new Set<string>();
    let busy: Promise<unknown> = Promise.resolve();
    /** Failed catalog looks in a row, for the backoff; the timer of the next look. */
    let failures = 0;
    let cancelCheck: (() => void) | null = null;
    /** Add-ons with an update held back while they said they were busy. */
    const waiting = new Set<string>();
    /** Add-ons being rolled back, so a burst of run changes rolls each back once. */
    const rolling = new Set<string>();

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
            failures = result.kind === "failed" ? failures + 1 : 0;
            if (result.kind !== "failed") fetchedAt = now();
            if (result.kind === "updated") {
                catalog = result.catalog;
                changed();
                void serial(applyUpdates).catch(() => undefined);
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

    /**
     * Fetch, check and unpack one entry and start it; the caller holds `serial`.
     * `started` is false when it went in but
     * starting it threw: the install stands and is reported as done, the start
     * apart, and the add-on's run state says the rest.
     */
    async function put(id: string, entry: AddonEntry, accepted: readonly AddonPermission[]): Promise<{ ok: true; started: boolean; } | { ok: false; reason: InstallFailure; }> {
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
            try {
                supervisor.drop(id);
                await reconcile();
                return { ok: true as const, started: true };
            } catch (error) {
                console.warn(`[addons] ${id} ${entry.version} is installed but did not start:`, error);
                return { ok: true as const, started: false };
            }
        } finally {
            delete installing[id];
            changed();
        }
    }

    /** Say it once: the version is written down as announced before the notice goes out. */
    async function tell(id: string, version: string, news: UpdateNews): Promise<void> {
        const fresh = await updateInstalled(options.dir, (installed) => {
            const addon = installed.addons[id];
            if (!addon || announced(addon.notified, version)) return false;
            addon.notified = version;
            return true;
        });
        if (fresh) options.notify?.(id, news);
    }

    /** Act on every installed add-on with a newer version in the catalog; the caller holds `serial`. */
    async function applyUpdates(): Promise<void> {
        await loadCatalog();
        if (!catalog) return;
        const installed = await readInstalled(options.dir);
        const runs = supervisor.snapshot();
        for (const [id, addon] of Object.entries(installed.addons)) {
            const entry = catalog.addons.find((item) => item.id === id);
            const decision = decideUpdate({
                installed: addon,
                entry,
                platform: options.platform,
                appVersion: options.appVersion,
                autoUpdate: installed.autoUpdate,
                busy: runs[id]?.status?.state === "busy"
            });
            if (decision.kind !== "wait") waiting.delete(id);
            if (!entry || decision.kind === "none") continue;
            const name = entry.name;
            if (decision.kind === "wait") {
                waiting.add(id);
                continue;
            }
            if (decision.kind === "consent") {
                await tell(id, decision.version, { kind: "consent", name, version: decision.version, added: decision.added });
                continue;
            }
            if (decision.kind === "offer") {
                await tell(id, decision.version, { kind: "available", name, version: decision.version, changelog: entry.changelog });
                continue;
            }
            // Only what was accepted before: decideUpdate holds any version that asks for more.
            const result = await put(id, entry, addon.granted);
            if (result.ok) await tell(id, decision.version, { kind: "updated", name, version: decision.version, changelog: entry.changelog });
            else {
                options.log?.(id, "warn", `update to ${decision.version} failed: ${result.reason}`);
                await tell(id, decision.version, { kind: "available", name, version: decision.version, changelog: entry.changelog });
            }
        }
    }

    /** A version that keeps crashing goes back to the one it replaced; a busy add-on that is free again gets its update. */
    async function afterRunChange(): Promise<void> {
        const runs = supervisor.snapshot();
        for (const [id, run] of Object.entries(runs)) {
            if (run.state !== "failed" || rolling.has(id)) continue;
            rolling.add(id);
            void serial(async () => {
                const addon = (await readInstalled(options.dir)).addons[id];
                if (!addon?.previous) return;
                const name = (await manifestOf(id, addon.version))?.name ?? id;
                supervisor.drop(id);
                const back = await rollbackAddon(options.dir, id);
                if (!back) return;
                options.log?.(id, "warn", `${back.from} kept failing; back to ${back.to}`);
                manifests.delete(`${id}@${back.from}`);
                await reconcile();
                options.notify?.(id, { kind: "rolled-back", name, from: back.from, to: back.to });
            })
                .catch(() => undefined)
                .finally(() => rolling.delete(id));
        }
        const freed = [...waiting].some((id) => runs[id]?.status?.state !== "busy");
        if (freed) await serial(applyUpdates).catch(() => undefined);
    }

    /** Look at the catalog now and again later: every 6 hours, sooner after a failure, backing off while offline. */
    function scheduleCheck(ms: number): void {
        cancelCheck?.();
        cancelCheck = later(() => {
            cancelCheck = null;
            void checkUpdates().finally(() => scheduleCheck(nextCheckDelay(failures)));
        }, ms);
    }

    /** One look: nothing is fetched while nothing is installed. */
    async function checkUpdates(): Promise<void> {
        const installed = await readInstalled(options.dir);
        if (Object.keys(installed.addons).length === 0) return;
        await revalidate().catch(() => undefined);
        await serial(applyUpdates).catch(() => undefined);
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
                const consent = update && entry ? addedPermissions(entry.permissions, addon.granted) : [];
                const run: InstalledView["run"] = !manifest
                    ? { state: "missing" }
                    : !addon.enabled
                      ? { state: "disabled" }
                      : (runs[id] ?? (devices && !addonDevicePresent(manifest, devices) ? { state: "sleeping" } : { state: "missing" }));
                views.push({
                    id,
                    version: addon.version,
                    enabled: addon.enabled,
                    granted: addon.granted,
                    manifest,
                    update,
                    autoUpdate: addon.autoUpdate ?? null,
                    consent,
                    failed: addon.failed ?? null,
                    run
                });
            }
            return {
                platform: options.platform,
                appVersion: options.appVersion,
                catalog,
                autoUpdate: autoUpdates(undefined, installed.autoUpdate),
                installed: views,
                installing: { ...installing }
            };
        },

        /** Refresh the catalog now, as the store's "check for updates" does, and act on what it brings. */
        async refresh(): Promise<void> {
            await revalidate();
            await serial(applyUpdates).catch(() => undefined);
        },

        /** Look for updates a minute after start, then on a schedule (`updates.ts`). */
        startUpdates(): void {
            if (!cancelCheck) scheduleCheck(FIRST_CHECK_MS);
        },

        /** One look for updates now, as the schedule does. */
        checkUpdates,

        /** Turn automatic updates on or off for one add-on (`id`), or for all (`id` null); null on one follows all again. */
        setAutoUpdate(id: string | null, value: boolean | null): Promise<boolean> {
            return serial(async () => {
                const found = await updateInstalled(options.dir, (installed) => {
                    if (id === null) {
                        if (value === null) delete installed.autoUpdate;
                        else installed.autoUpdate = value;
                        return true;
                    }
                    const addon = installed.addons[id];
                    if (!addon) return false;
                    if (value === null) delete addon.autoUpdate;
                    else addon.autoUpdate = value;
                    return true;
                });
                if (found) {
                    changed();
                    await applyUpdates();
                }
                return found;
            });
        },

        install(id: string, accepted: readonly AddonPermission[]): Promise<{ ok: true; started: boolean; } | { ok: false; reason: InstallFailure | "unknown"; }> {
            return serial(async () => {
                await loadCatalog();
                const entry = catalog?.addons.find((item) => item.id === id);
                if (!entry) return { ok: false as const, reason: "unknown" as const };
                const result = await put(id, entry, accepted);
                // Put in by the person: nothing more to announce about this version.
                if (result.ok) {
                    await updateInstalled(options.dir, (installed) => {
                        const addon = installed.addons[id];
                        if (addon) addon.notified = entry.version;
                        return Boolean(addon);
                    });
                }
                return result;
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

        stop: () => {
            cancelCheck?.();
            cancelCheck = null;
            supervisor.stopAll();
        }
    };
}

export type AddonManager = ReturnType<typeof createAddonManager>;
