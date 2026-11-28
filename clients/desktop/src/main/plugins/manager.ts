/**
 * Device plugins on this computer: the catalog, what is installed, what runs.
 *
 * Costs nothing until used: with nothing installed no file but `installed.json`
 * is read, no process starts and nothing is fetched - the catalog is fetched
 * when the store is opened, or, where plugs can be heard, to offer support for a
 * device that was just plugged in. Pure of Electron (the process, the fetch and
 * the notice are given), for the tests.
 */

import { join } from "node:path";
import type { Fetcher } from "./catalog";
import type { PluginLive, PluginMethod } from "@/shared/plugin-protocol";
import type { TrustedKey } from "./signature";
import { cachedCatalog, refreshCatalog, CATALOG_URL, LEGACY_CATALOG_URL, type Refresh } from "./catalog";
import { addedPermissions, announced, autoUpdates, busyHoldsUpdate, decideUpdate, FIRST_CHECK_MS, nextCheckDelay, type UpdateNews } from "./updates";
import { createSupervisor, type PluginChild, type PluginRun, type WantedPlugin } from "./supervisor";
import {
    pluginDevicePresent,
    pluginFit,
    pluginsClaiming,
    comparePluginVersions,
    readPluginSettingChange,
    applyPluginProfileRequest,
    choosePluginProfile,
    holdPluginProfile,
    pluginProfileRequestSchema,
    pluginProfileValues,
    DEFAULT_PLUGIN_PROFILE,
    NO_PLUGIN_PROFILE_HOLD,
    type PluginProfileError,
    type PluginProfileHold,
    type PluginProfiles,
    type PluginProfileSignals,
    type PluginProfilesView,
    type PluginCatalog,
    type PluginEntry,
    type PluginManifest,
    type PluginPermission,
    type PluginPlatform,
    type PluginSettingValue,
    type UsbDevice
} from "@polaris/core/device-plugins";
import {
    installPlugin,
    installedManifest,
    packageDir,
    readPluginSettings,
    readPluginProfilesFile,
    readInstalled,
    rollbackPlugin,
    setPluginEnabled,
    updateInstalled,
    uninstallPlugin,
    writePluginSettings,
    writePluginProfilesFile,
    type InstallFailure
} from "./packages";

/** How long a catalog on the device is used before a plug of a claimed device looks again. */
export const CATALOG_FRESH_MS = 6 * 60 * 60_000;
/**
 * The store screen looks at the published list behind every read, drawing the
 * copy on the device at once (stale-while-revalidate); this only stops the burst
 * of reads one install or one open makes from each asking GitHub again.
 */
export const STORE_REVALIDATE_MS = 30_000;
/**
 * The longest an install or update the person asked for may take before the
 * page is told it did not go in. A package is well under a megabyte, so this is
 * only ever reached by something stuck (0.1.129 left the Update button with no
 * answer at all).
 */
export const INSTALL_LIMIT_MS = 3 * 60_000;

/** Why an install the person asked for did not go in. */
export type InstallCallFailure = InstallFailure | "unknown" | "timeout" | "failed";
export type InstallCallResult = { ok: true; started: boolean; } | { ok: false; reason: InstallCallFailure; };
/** A line for the desktop's persistent log (`perf.log`): short tokens and numbers only. */
export type PluginRecord = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export interface ManagerOptions {
    readonly dir: string;
    readonly platform: PluginPlatform | null;
    readonly appVersion: string;
    readonly fetcher: Fetcher;
    readonly fork: (wanted: WantedPlugin) => PluginChild;
    readonly call: (id: string, method: PluginMethod, params: unknown) => Promise<unknown>;
    /** Devices plugged in now, or null where that cannot be known (presence.ts). */
    readonly devices: () => UsbDevice[] | null;
    /** A device a catalog plugin supports was plugged in and the plugin is not installed. */
    readonly offer?: (entry: PluginEntry, deviceName: string) => void;
    readonly onChange?: () => void;
    /** A running plugin's live values, as they come. */
    readonly onLive?: (id: string, live: PluginLive) => void;
    /** Tell the person about an update: put in, waiting for them, or rolled back. Once per version. */
    readonly notify?: (id: string, news: UpdateNews) => void;
    /** Run `work` after `ms`; answers how to cancel it. A real timer by default. */
    readonly later?: (work: () => void, ms: number) => () => void;
    /** The timer a crashed plugin is restarted on (the supervisor's own by default). For the tests. */
    readonly restartTimer?: (run: () => void, ms: number) => unknown;
    readonly log?: (id: string, level: "info" | "warn" | "error", text: string) => void;
    /** Installs and updates, started and ended, for the log kept on disk. */
    readonly record?: PluginRecord;
    /** `INSTALL_LIMIT_MS` by default; for the tests. */
    readonly installLimitMs?: number;
    /** The app's language, handed to each plugin when it starts. */
    readonly locale?: () => string;
    readonly catalogUrl?: string;
    readonly keys?: readonly TrustedKey[];
    readonly now?: () => number;
    /** What this computer can tell for profile rules (a meeting in another app, the app in front); neither when left out. */
    readonly profileReads?: PluginProfilesView["reads"];
    /** A created profile's id. */
    readonly profileId?: () => string;
}

/** What a profile request answers: done (and the profile it was about), or why not. */
export type ProfileResult = { readonly ok: true; readonly id: string | null } | { readonly ok: false; readonly error: PluginProfileError | "bad-request" | "unknown" };

/** What no app has told yet: nothing is running and no call is on. */
export const NO_PROFILE_SIGNALS: PluginProfileSignals = { call: false, meeting: null, games: [], front: null };

export interface InstalledView {
    readonly id: string;
    readonly version: string;
    readonly enabled: boolean;
    readonly granted: readonly PluginPermission[];
    readonly manifest: PluginManifest | null;
    /** The catalog's newer version, when there is one this app can install. */
    readonly update: string | null;
    /** Its own automatic-update choice; null follows the setting for every plugin. */
    readonly autoUpdate: boolean | null;
    /** The permissions `update` asks for that were not accepted: it waits for the person while any are. */
    readonly consent: readonly PluginPermission[];
    /** A version that failed here and was rolled back from. */
    readonly failed: string | null;
    /** Its profiles and the one in use, for a plugin whose manifest has `profiles`; null otherwise. */
    readonly profiles: PluginProfilesView | null;
    /** Running, or why not: "disabled", "sleeping" (its device is unplugged) or "missing" (its files are gone). */
    readonly run: PluginRun | { readonly state: "disabled" | "sleeping" | "missing"; };
}

export interface PluginsSnapshot {
    readonly platform: PluginPlatform | null;
    readonly appVersion: string;
    readonly catalog: PluginCatalog | null;
    /** Whether updates go in by themselves, for every plugin without a choice of its own. */
    readonly autoUpdate: boolean;
    readonly installed: readonly InstalledView[];
    readonly installing: Readonly<Record<string, { readonly received: number; readonly total: number; }>>;
}

function realTimer(work: () => void, ms: number): () => void {
    const timer = setTimeout(work, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
}

export function createPluginManager(options: ManagerOptions) {
    const now = options.now ?? Date.now;
    const later = options.later ?? realTimer;
    const record: PluginRecord = (event, fields) => options.record?.(event, fields);
    const changed = () => options.onChange?.();
    /** A run changed: roll back a version that keeps failing, and put in an update that waited on a busy plugin. */
    const runChanged = () => {
        changed();
        void afterRunChange();
    };
    const supervisor = createSupervisor({
        fork: options.fork,
        call: options.call,
        onChange: runChanged,
        ...(options.onLive ? { onLive: options.onLive } : {}),
        log: options.log,
        ...(options.locale ? { locale: options.locale } : {}),
        ...(options.restartTimer ? { setTimer: options.restartTimer } : {})
    });
    let catalog: PluginCatalog | null = null;
    let catalogRead = false;
    let fetchedAt = 0;
    /** When a store read last started a look, and the held list's ETag for a cheap conditional one. */
    let lookedAt = Number.NEGATIVE_INFINITY;
    let catalogEtag: string | null = null;
    let refreshing: Promise<Refresh["kind"]> | null = null;
    const installing: Record<string, { received: number; total: number; }> = {};
    const manifests = new Map<string, PluginManifest | null>();
    const offered = new Set<string>();
    let busy: Promise<unknown> = Promise.resolve();
    /** Failed catalog looks in a row, for the backoff; the timer of the next look. */
    let failures = 0;
    let cancelCheck: (() => void) | null = null;
    /** Plugins with an update held back while they said they were busy. */
    const waiting = new Set<string>();
    /** Plugins being rolled back, so a burst of run changes rolls each back once. */
    const rolling = new Set<string>();
    /** Plugins held stopped while something needs their device free (`whileStopped`): no reconcile starts them meanwhile. */
    const held = new Set<string>();
    /** Installs the person asked for that have not ended, so the card shows them at once, even while queued. */
    const asked = new Set<string>();

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

    function revalidate(): Promise<Refresh["kind"]> {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            await loadCatalog();
            let result = await refreshCatalog(options.dir, options.fetcher, catalog, options.catalogUrl ?? CATALOG_URL, options.keys, catalogEtag);
            // The address from before the rename, while CI still publishes there.
            if (result.kind === "failed" && !options.catalogUrl) result = await refreshCatalog(options.dir, options.fetcher, catalog, LEGACY_CATALOG_URL, options.keys);
            failures = result.kind === "failed" ? failures + 1 : 0;
            if (result.kind !== "failed") {
                fetchedAt = now();
                catalogEtag = result.etag;
            }
            if (result.kind === "updated") {
                catalog = result.catalog;
                changed();
                void serial(applyUpdates).catch(() => undefined);
            }
            return result.kind;
        })().finally(() => {
            refreshing = null;
        });
        return refreshing;
    }

    async function manifestOf(id: string, version: string): Promise<PluginManifest | null> {
        const key = `${id}@${version}`;
        if (!manifests.has(key)) manifests.set(key, await installedManifest(options.dir, id, version));
        return manifests.get(key) ?? null;
    }

    /**
     * Fetch, check and unpack one entry and start it; the caller holds `serial`.
     * `started` is false when it went in but
     * starting it threw: the install stands and is reported as done, the start
     * apart, and the plugin's run state says the rest.
     */
    async function put(id: string, entry: PluginEntry, accepted: readonly PluginPermission[]): Promise<{ ok: true; started: boolean; } | { ok: false; reason: InstallFailure; }> {
        installing[id] = { received: 0, total: 0 };
        changed();
        try {
            const result = await installPlugin({
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
                console.warn(`[plugins] ${id} ${entry.version} is installed but did not start:`, error);
                return { ok: true as const, started: false };
            }
        } finally {
            delete installing[id];
            changed();
        }
    }

    /**
     * Say it once: the version is written down as announced before the notice goes out.
     * A failed write skips this notice (the next look says it) and never stops the updates after it.
     */
    async function tell(id: string, version: string, news: UpdateNews): Promise<void> {
        const fresh = await updateInstalled(options.dir, (installed) => {
            const plugin = installed.plugins[id];
            if (!plugin || announced(plugin.notified, version)) return false;
            plugin.notified = version;
            return true;
        }).catch(() => false);
        if (fresh) options.notify?.(id, news);
    }

    /** Act on every installed plugin with a newer version in the catalog; the caller holds `serial`. */
    async function applyUpdates(): Promise<void> {
        await loadCatalog();
        if (!catalog) return;
        const installed = await readInstalled(options.dir);
        const runs = supervisor.snapshot();
        for (const [id, plugin] of Object.entries(installed.plugins)) {
            const entry = catalog.plugins.find((item) => item.id === id);
            const decision = decideUpdate({
                installed: plugin,
                entry,
                platform: options.platform,
                appVersion: options.appVersion,
                autoUpdate: installed.autoUpdate,
                busy: busyHoldsUpdate(runs[id]?.status)
            });
            if (decision.kind !== "wait") waiting.delete(id);
            if (!entry || decision.kind === "none") continue;
            const name = entry.name;
            if (decision.kind === "wait") {
                if (!waiting.has(id)) record("plugin-update-wait", { id, version: decision.version, code: runs[id]?.status?.code ?? "-" });
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
            record("plugin-update", { id, step: "start", from: plugin.version, to: decision.version });
            const result = await put(id, entry, plugin.granted);
            record("plugin-update", { id, step: "end", to: decision.version, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) });
            if (result.ok) await tell(id, decision.version, { kind: "updated", name, version: decision.version, changelog: entry.changelog });
            else {
                options.log?.(id, "warn", `update to ${decision.version} failed: ${result.reason}`);
                await tell(id, decision.version, { kind: "available", name, version: decision.version, changelog: entry.changelog });
            }
        }
    }

    /** A version that keeps crashing goes back to the one it replaced; a busy plugin that is free again gets its update. */
    async function afterRunChange(): Promise<void> {
        const runs = supervisor.snapshot();
        for (const [id, run] of Object.entries(runs)) {
            if (run.state !== "failed" || rolling.has(id)) continue;
            rolling.add(id);
            void serial(async () => {
                const plugin = (await readInstalled(options.dir)).plugins[id];
                if (!plugin?.previous) return;
                const name = (await manifestOf(id, plugin.version))?.name ?? id;
                supervisor.drop(id);
                const back = await rollbackPlugin(options.dir, id);
                if (!back) return;
                options.log?.(id, "warn", `${back.from} kept failing; back to ${back.to}`);
                manifests.delete(`${id}@${back.from}`);
                await reconcile();
                options.notify?.(id, { kind: "rolled-back", name, from: back.from, to: back.to });
            })
                .catch(() => undefined)
                .finally(() => rolling.delete(id));
        }
        const freed = [...waiting].some((id) => !busyHoldsUpdate(runs[id]?.status));
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
        if (Object.keys(installed.plugins).length === 0) return;
        await revalidate().catch(() => undefined);
        await serial(applyUpdates).catch(() => undefined);
    }

    /** Start what is installed, enabled and has its device; stop the rest. */
    /** Each profiled plugin's stored profiles (read once, then kept: only this manager writes them) and its hold. */
    const kept = new Map<string, { version: string; profiles: PluginProfiles; hold: PluginProfileHold }>();
    let signals: PluginProfileSignals = NO_PROFILE_SIGNALS;
    const profileId = options.profileId ?? (() => Math.random().toString(36).slice(2, 12));

    async function profileState(manifest: PluginManifest): Promise<{ version: string; profiles: PluginProfiles; hold: PluginProfileHold }> {
        let state = kept.get(manifest.id);
        // Read again for a new version: its settings, and so what fits them, may have changed.
        if (!state || state.version !== manifest.version) {
            state = { version: manifest.version, profiles: await readPluginProfilesFile(options.dir, manifest), hold: state?.hold ?? NO_PLUGIN_PROFILE_HOLD };
            kept.set(manifest.id, state);
        }
        // The first look, and the one after a request, takes the choice at once.
        if (!state.hold.active) state.hold = holdPluginProfile(NO_PLUGIN_PROFILE_HOLD, choosePluginProfile(state.profiles, signals), now());
        return state;
    }

    /** The id of the profile in use, Default for a plugin without profiles. */
    async function activeProfile(manifest: PluginManifest): Promise<string> {
        if (!manifest.profiles) return DEFAULT_PLUGIN_PROFILE;
        return (await profileState(manifest)).hold.active?.id ?? DEFAULT_PLUGIN_PROFILE;
    }

    /** What the plugin runs with: the settings file, under the profile in use. */
    async function runningSettings(manifest: PluginManifest): Promise<Record<string, PluginSettingValue>> {
        const flat = await readPluginSettings(options.dir, manifest);
        if (!manifest.profiles) return flat;
        const state = await profileState(manifest);
        return pluginProfileValues(flat, state.profiles, state.hold.active?.id ?? DEFAULT_PLUGIN_PROFILE);
    }

    async function profilesView(manifest: PluginManifest): Promise<PluginProfilesView | null> {
        if (!manifest.profiles) return null;
        const { profiles, hold } = await profileState(manifest);
        return {
            list: profiles.list.map(({ id, name, rules }) => ({ id, name, rules })),
            manual: profiles.manual,
            active: hold.active ?? { id: DEFAULT_PLUGIN_PROFILE, reason: "default", subject: null },
            reads: options.profileReads ?? { meeting: false, front: false }
        };
    }

    async function reconcile(): Promise<void> {
        const installed = await readInstalled(options.dir);
        const devices = options.devices();
        if (devices) supervisor.devices(devices);
        for (const id of supervisor.running()) if (!installed.plugins[id]?.enabled) supervisor.drop(id);
        for (const [id, plugin] of Object.entries(installed.plugins)) {
            const manifest = plugin.enabled ? await manifestOf(id, plugin.version) : null;
            const entry = manifest && options.platform ? manifest.entries[options.platform] : undefined;
            if (!manifest || !entry || held.has(id) || (devices && !pluginDevicePresent(manifest, devices))) {
                supervisor.drop(id);
                continue;
            }
            supervisor.want({
                manifest,
                granted: plugin.granted,
                entryPath: join(packageDir(options.dir, id, plugin.version), ...entry.split("/")),
                settings: await runningSettings(manifest)
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
            for (const { entry, claim } of pluginsClaiming(catalog, devices)) {
                if (installed.plugins[entry.id] || offered.has(entry.id) || !pluginFit(entry, options.platform, options.appVersion).ok) continue;
                offered.add(entry.id);
                options.offer(entry, claim.name);
            }
        },

        /**
         * Everything a store screen draws, at once from what is on the device, while
         * the published list is looked at behind it; a newer one reaches the screen
         * through `changed`, so an update shows without restarting the app.
         */
        async snapshot(): Promise<PluginsSnapshot> {
            await loadCatalog();
            if (now() - lookedAt >= STORE_REVALIDATE_MS) {
                lookedAt = now();
                void revalidate().catch(() => undefined);
            }
            const installed = await readInstalled(options.dir);
            const devices = options.devices();
            const runs = supervisor.snapshot();
            const views: InstalledView[] = [];
            for (const [id, plugin] of Object.entries(installed.plugins)) {
                const manifest = await manifestOf(id, plugin.version);
                const entry = catalog?.plugins.find((item) => item.id === id);
                const update =
                    entry && comparePluginVersions(entry.version, plugin.version) > 0 && pluginFit(entry, options.platform, options.appVersion).ok ? entry.version : null;
                const consent = update && entry ? addedPermissions(entry.permissions, plugin.granted) : [];
                const run: InstalledView["run"] = !manifest
                    ? { state: "missing" }
                    : !plugin.enabled
                      ? { state: "disabled" }
                      : (runs[id] ?? (devices && !pluginDevicePresent(manifest, devices) ? { state: "sleeping" } : { state: "missing" }));
                views.push({
                    id,
                    version: plugin.version,
                    enabled: plugin.enabled,
                    granted: plugin.granted,
                    manifest,
                    update,
                    autoUpdate: plugin.autoUpdate ?? null,
                    consent,
                    failed: plugin.failed ?? null,
                    profiles: manifest ? await profilesView(manifest) : null,
                    run
                });
            }
            return {
                platform: options.platform,
                appVersion: options.appVersion,
                catalog,
                autoUpdate: autoUpdates(undefined, installed.autoUpdate),
                installed: views,
                // Asked for and queued behind other work: shown as starting, then as its download.
                installing: { ...Object.fromEntries([...asked].map((id) => [id, { received: 0, total: 0 }])), ...installing }
            };
        },

        /**
         * Refresh the catalog now, as the store's "check for updates" does, and act on
         * what it brings. Answers whether the list was reached, so the store can say
         * "up to date" only when it really looked.
         */
        async refresh(): Promise<Refresh["kind"]> {
            const kind = await revalidate();
            await serial(applyUpdates).catch(() => undefined);
            return kind;
        },

        /** Look for updates a minute after start, then on a schedule (`updates.ts`). */
        startUpdates(): void {
            if (!cancelCheck) scheduleCheck(FIRST_CHECK_MS);
        },

        /** One look for updates now, as the schedule does. */
        checkUpdates,

        /** Turn automatic updates on or off for one plugin (`id`), or for all (`id` null); null on one follows all again. */
        setAutoUpdate(id: string | null, value: boolean | null): Promise<boolean> {
            return serial(async () => {
                const found = await updateInstalled(options.dir, (installed) => {
                    if (id === null) {
                        if (value === null) delete installed.autoUpdate;
                        else installed.autoUpdate = value;
                        return true;
                    }
                    const plugin = installed.plugins[id];
                    if (!plugin) return false;
                    if (value === null) delete plugin.autoUpdate;
                    else plugin.autoUpdate = value;
                    return true;
                });
                if (found) {
                    changed();
                    await applyUpdates();
                }
                return found;
            });
        },

        /**
         * Install or update one plugin because the person asked. Never waits on a
         * busy plugin (that only holds automatic updates), always answers within
         * `INSTALL_LIMIT_MS`, and a call that timed out while still queued does
         * nothing when its turn comes.
         */
        install(id: string, accepted: readonly PluginPermission[]): Promise<InstallCallResult> {
            const began = now();
            let late = false;
            asked.add(id);
            changed();
            record("plugin-install", { id, step: "start" });
            const work = serial(async (): Promise<InstallCallResult> => {
                if (late) return { ok: false, reason: "timeout" };
                await loadCatalog();
                const entry = catalog?.plugins.find((item) => item.id === id);
                if (!entry) return { ok: false as const, reason: "unknown" as const };
                const result = await put(id, entry, accepted);
                // Put in by the person: nothing more to announce about this version. Only
                // bookkeeping: failing to write it down must not report an install that
                // went in as failed (0.1.99 did, when Windows refused the rename).
                if (result.ok) {
                    await updateInstalled(options.dir, (installed) => {
                        const plugin = installed.plugins[id];
                        if (plugin) plugin.notified = entry.version;
                        return Boolean(plugin);
                    }).catch((error: unknown) => console.warn(`[plugins] ${id} ${entry.version} is installed; noting it as announced failed:`, error));
                }
                return result;
            }).catch((error: unknown): InstallCallResult => {
                options.log?.(id, "error", `install failed: ${error instanceof Error ? error.message : String(error)}`);
                return { ok: false, reason: "failed" };
            });
            let cancel: () => void = () => undefined;
            const limit = new Promise<InstallCallResult>((done) => {
                cancel = later(() => {
                    late = true;
                    done({ ok: false, reason: "timeout" });
                }, options.installLimitMs ?? INSTALL_LIMIT_MS);
            });
            return Promise.race([work, limit]).then((result) => {
                cancel();
                asked.delete(id);
                changed();
                if (!result.ok && result.reason === "timeout") options.log?.(id, "warn", `install did not end within ${Math.round((options.installLimitMs ?? INSTALL_LIMIT_MS) / 1000)} s`);
                record("plugin-install", { id, step: "end", ok: result.ok, ms: now() - began, ...(result.ok ? { started: result.started } : { reason: result.reason }) });
                return result;
            });
        },

        uninstall(id: string): Promise<void> {
            return serial(async () => {
                supervisor.drop(id);
                await uninstallPlugin(options.dir, id);
                kept.delete(id);
                for (const key of [...manifests.keys()]) if (key.startsWith(`${id}@`)) manifests.delete(key);
                await reconcile();
            });
        },

        setEnabled(id: string, enabled: boolean): Promise<boolean> {
            return serial(async () => {
                const found = await setPluginEnabled(options.dir, id, enabled);
                if (found) await reconcile();
                return found;
            });
        },

        async settings(id: string): Promise<Record<string, PluginSettingValue> | null> {
            const plugin = (await readInstalled(options.dir)).plugins[id];
            const manifest = plugin ? await manifestOf(id, plugin.version) : null;
            return manifest ? runningSettings(manifest) : null;
        },

        /** Change one setting; answers every value after it, or null when the key or value does not fit. */
        setSetting(id: string, key: unknown, value: unknown): Promise<Record<string, PluginSettingValue> | null> {
            return serial(async () => {
                const plugin = (await readInstalled(options.dir)).plugins[id];
                const manifest = plugin ? await manifestOf(id, plugin.version) : null;
                if (!manifest) return null;
                const change = readPluginSettingChange(manifest.settings, key, value);
                if (!change) return null;
                // A grouped setting changes the profile in use; one in no group, and any under Default, the settings file.
                const active = await activeProfile(manifest);
                const grouped = manifest.settings.find((setting) => setting.key === change.key)?.group !== undefined;
                const state = kept.get(id);
                if (active !== DEFAULT_PLUGIN_PROFILE && grouped && state) {
                    const list = state.profiles.list.map((item) => (item.id === active ? { ...item, values: { ...item.values, [change.key]: change.value } } : item));
                    await writePluginProfilesFile(options.dir, id, { ...state.profiles, list });
                    state.profiles = { ...state.profiles, list };
                } else {
                    await writePluginSettings(options.dir, id, { ...(await readPluginSettings(options.dir, manifest)), [change.key]: change.value });
                }
                const values = await runningSettings(manifest);
                supervisor.settings(id, values);
                changed();
                return values;
            });
        },

        /** Create, rename, delete, set the rules of, or pick one of a plugin's profiles (`pluginProfileRequestSchema`). */
        profile(id: string, raw: unknown): Promise<ProfileResult> {
            const parsed = pluginProfileRequestSchema.safeParse(raw);
            if (!parsed.success) return Promise.resolve({ ok: false, error: "bad-request" });
            return serial(async (): Promise<ProfileResult> => {
                const plugin = (await readInstalled(options.dir)).plugins[id];
                const manifest = plugin ? await manifestOf(id, plugin.version) : null;
                if (!manifest?.profiles) return { ok: false, error: "unknown" };
                const state = await profileState(manifest);
                const outcome = applyPluginProfileRequest(manifest.settings, await readPluginSettings(options.dir, manifest), state.profiles, parsed.data, profileId);
                if (!outcome.ok) return outcome;
                await writePluginProfilesFile(options.dir, id, outcome.profiles);
                state.profiles = outcome.profiles;
                // What is in use is chosen again now, with no hold: the person just changed it.
                state.hold = NO_PLUGIN_PROFILE_HOLD;
                supervisor.settings(id, await runningSettings(manifest));
                changed();
                return { ok: true, id: outcome.id };
            });
        },

        /** Whether any plugin has a rule on a meeting or on the app in front, so the app looks only when something asks. */
        profileNeeds(): { readonly meeting: boolean; readonly front: boolean } {
            let meeting = false;
            let front = false;
            for (const { profiles } of kept.values()) {
                for (const { rules } of profiles.list) {
                    meeting ||= rules.meeting;
                    front ||= rules.apps.length > 0;
                }
            }
            return { meeting, front };
        },

        /**
         * What the app sees now (a call, the microphone, games, the app in
         * front): each running plugin with profiles switches once its new
         * choice has held for PLUGIN_PROFILE_HOLD_MS.
         */
        async profileSignals(next: PluginProfileSignals): Promise<void> {
            // Called every second: nothing is read from disk, and nothing done while nothing changed or waits out a hold.
            const same = JSON.stringify(next) === JSON.stringify(signals);
            signals = next;
            if (same && [...kept.values()].every((state) => state.hold.pending === null)) return;
            let moved = false;
            for (const [id, state] of kept) {
                const manifest = await manifestOf(id, state.version);
                if (!manifest?.profiles) continue;
                const before = state.hold.active;
                state.hold = holdPluginProfile(state.hold, choosePluginProfile(state.profiles, signals), now());
                const after = state.hold.active;
                if (before?.id === after?.id && before?.reason === after?.reason && before?.subject === after?.subject) continue;
                moved = true;
                if (before?.id !== after?.id) supervisor.settings(id, await runningSettings(manifest));
            }
            if (moved) changed();
        },

        /**
         * Runs `work` with the plugin stopped and kept stopped, then starts what
         * should run again. A driver swap needs the device free: a plugin still
         * holding it (the Hercules SDK route) makes Windows leave the new driver
         * waiting for a restart. A plug event during `work` does not restart it.
         */
        async whileStopped<T>(id: string, work: () => Promise<T>): Promise<T> {
            held.add(id);
            supervisor.drop(id);
            try {
                return await work();
            } finally {
                held.delete(id);
                await serial(reconcile).catch(() => undefined);
            }
        },

        stop: () => {
            cancelCheck?.();
            cancelCheck = null;
            supervisor.stopAll();
        }
    };
}

export type PluginManager = ReturnType<typeof createPluginManager>;
