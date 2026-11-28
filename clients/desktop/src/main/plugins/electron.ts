/**
 * The plugin manager in the running app: utility processes, `net.fetch`, the
 * USB watch, the "found a device" notice, and the bridge the host's Settings
 * draws the store from (`window.polarisDesktop.plugins`).
 */

import { z } from "zod";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { packageDir, pluginsFolder } from "./packages";
import { judgeViewCall, readViewUrl, resolveViewFile, viewContentType, VIEW_CSP, VIEW_SCHEMES } from "./view";
import { CHANNELS } from "@/shared/bridge";
import type { PluginAction, PluginLive } from "@/shared/plugin-protocol";
import { DeviceActions, windowsKeyCodes } from "./device-actions";
import { openExternal } from "../open-external";
import { launcherEntries, runLauncherEntry } from "../launcher";
import { startProgram } from "../launcher-apps";
import { setTrayPlugins } from "../tray";
import { watchUsb, type UsbWatch } from "./presence";
import { pluginShortcuts, sameShortcuts, type PluginShortcuts } from "./ways-in";
import type { PluginChild, WantedPlugin } from "./supervisor";
import { createPluginManager, type PluginManager } from "./manager";
import { createRequirements, type EnsureReason, type Requirements } from "./requirements";
import { sharedWindowsLister } from "../game-detect";
import { watchProfileSignals } from "./profile-signals";
import { createCollisionWatch, takeOverAction, TAKE_OVER_ACTION, type CollisionWatch } from "./collision";
import { answerOfficial, DRIVER_REQUIREMENT, driverRunnerFor, lookDriver, officialRequestSchema, officialRunnerFor, requirementRunnerFor, udevRunnerFor } from "./official";
import { showNotice } from "../notices";
import { newsWords } from "./updates";
import { perfEvent } from "../perf-watch";
import { answerInstall, pluginIdSchema, requirementKeySchema } from "./install-call";
import { callPageAction, voiceStateNow, voiceWidgetAction } from "../voice-widget";
import { deviceActionRequestSchema, readActionRef, PLUGIN_PERMISSIONS, pluginPlatform, pluginRequirements, pluginText, type PluginManifest, type UsbDevice } from "@polaris/core/device-plugins";
import { app, dialog, ipcMain, net, Notification, protocol, shell, utilityProcess, webContents, type IpcMainInvokeEvent } from "electron";

let manager: PluginManager | null = null;
/** The program keys of the games this app sees running, sent as `games` in a `polaris.state` answer. */
let runningGames: () => readonly string[] = () => [];
let requirements: Requirements | null = null;
/** A device's own vendor program holding it (`collision.ts`); Windows only. */
let collisions: CollisionWatch | null = null;
/** Requirement setups run one after another, so no two permission prompts are open at once. */
let ensuring: Promise<void> = Promise.resolve();
let usb: UsbWatch | null = null;
let devices: UsbDevice[] | null = null;
let shortcuts: PluginShortcuts = { installed: [], plugged: [] };
/** Whether a look at the installed plugins is under way, and whether another was asked for meanwhile. */
let looking: Promise<void> | null = null;
let lookAgain = false;

let folder: string | null = null;
/** Resolved once: the first call moves a folder from before the rename (`pluginsFolder`). */
const pluginsDir = (): string => (folder ??= pluginsFolder(app.getPath("userData")));

/** The installed plugin's manifest, or null. */
async function installedManifest(id: string): Promise<PluginManifest | null> {
    return (await manager?.snapshot())?.installed.find((plugin) => plugin.id === id)?.manifest ?? null;
}

/** Set up what one installed plugin (or every one) has this platform set up for it (`requirements.ts`), one at a time. */
function ensureRequirements(reason: EnsureReason, id?: string): Promise<void> {
    ensuring = ensuring.then(async () => {
        if (!manager || !requirements) return;
        for (const plugin of (await manager.snapshot()).installed) {
            if ((id && plugin.id !== id) || !plugin.manifest) continue;
            await requirements.ensure(plugin.id, plugin.manifest, reason).catch(() => undefined);
        }
    });
    return ensuring;
}

/** The manager's snapshot with what the app offers to do for each plugin (`InstalledPlugin.actions`). */
async function snapshotWithActions(running: PluginManager): Promise<unknown> {
    const snapshot = await running.snapshot();
    const installed = await Promise.all(
        snapshot.installed.map(async (plugin) => {
            const program = collisions?.program(plugin.id) ?? null;
            const own = plugin.manifest && requirements ? await requirements.actions(plugin.id, plugin.manifest) : [];
            return { ...plugin, actions: program ? [takeOverAction(program), ...own].slice(0, 8) : own };
        })
    );
    return { ...snapshot, installed };
}

/**
 * "Use it in Polaris": close the vendor program that holds the device, and only
 * on the person's click (after the page asked them). The plugin lets go of the
 * device meanwhile and opens it again the moment the program is gone; when the
 * vendor's driver is still on it, Polaris' own goes on (Windows' one prompt), so
 * the program cannot take it back the next time it starts.
 */
async function takeOver(running: PluginManager, id: string, found: PluginManifest): Promise<boolean> {
    const official = officialRunnerFor(id, pluginsDir());
    if (!official) return false;
    const closed = await running.whileStopped(id, () => official.close()).catch(() => false);
    // A person's click: the driver is looked at again, not read from the last look.
    const state = closed ? await driverRunnerFor(id, pluginsDir())?.state().catch(() => null) : null;
    await collisions?.tick();
    if (!closed) return false;
    const held = requirements;
    if (held && state && (state.state === "needed" || state.state === "repair")) {
        const run = ensuring.then(() => held.run(id, found, DRIVER_REQUIREMENT));
        ensuring = run.then(() => undefined, () => undefined);
        await run.catch(() => false);
    }
    broadcast(CHANNELS.pluginsChanged);
    return true;
}

/** Starts the device's official app for a plugin, when one is registered for it here (`official.ts`). */
function launchOfficial(id: string): Promise<boolean> {
    return officialRunnerFor(id, pluginsDir())?.launch() ?? Promise.resolve(false);
}

/** Every installed plugin, for the launcher's "Configure <name>" rows. Empty until the manager has started. */
export function pluginShortcutsNow(): PluginShortcuts {
    return shortcuts;
}

/** What the plugin bridge answers (`plugins.get`), for the launcher's search; null until the manager has started. */
export async function pluginsSnapshotNow(): Promise<unknown> {
    return manager ? manager.snapshot() : null;
}

/**
 * Read what is installed and plugged again and put the tray's plugin items up
 * to date. One look at a time; a change heard during one is looked at after it.
 */
function lookAtShortcuts(show: (path?: string) => void): void {
    if (looking) {
        lookAgain = true;
        return;
    }
    looking = (async () => {
        if (!manager) return;
        const next = pluginShortcuts((await manager.snapshot()).installed, devices);
        const trayChanged = !sameShortcuts(next.plugged, shortcuts.plugged);
        shortcuts = next;
        if (trayChanged) {
            setTrayPlugins(next.plugged, (id) => {
                const found = shortcuts.installed.find((item) => item.id === id);
                show(found?.path);
            });
        }
    })()
        .catch(() => undefined)
        .finally(() => {
            looking = null;
            if (lookAgain) {
                lookAgain = false;
                lookAtShortcuts(show);
            }
        });
}

/** Only what a native module needs to load: the plugin gets none of the app's own environment. */
function pluginEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "LANG", "XDG_RUNTIME_DIR"]) {
        const value = process.env[key];
        if (value) env[key] = value;
    }
    return env;
}

function fork(wanted: WantedPlugin): PluginChild {
    const child = utilityProcess.fork(wanted.entryPath, [], {
        serviceName: `Polaris plugin: ${wanted.manifest.name}`,
        stdio: "ignore",
        cwd: join(wanted.entryPath, ".."),
        env: pluginEnv()
    });
    return {
        postMessage: (message) => child.postMessage(message),
        kill: () => {
            child.kill();
        },
        onMessage: (listener) => child.on("message", listener),
        onExit: (listener) => child.on("exit", listener)
    };
}

/**
 * One of PLUGIN_ACTIONS, done by the page holding the call. Mute, deafen and
 * hanging up go the way the voice widget's buttons do, which every page that
 * reports a call understands; the camera and the screen go on a channel of
 * their own, so a page older than it hears nothing rather than something else.
 */
function runPluginAction(action: PluginAction): boolean {
    switch (action) {
        case "call.mic":
            return voiceWidgetAction("mic");
        case "call.deafen":
            return voiceWidgetAction("deafen");
        case "call.hangup":
        case "call.leave":
            return voiceWidgetAction("leave");
        case "call.camera":
            return callPageAction("camera");
        case "call.share":
            return callPageAction("share");
    }
}

/**
 * The custom actions on this computer (`device-actions.ts`), kept beside the
 * installed plugins. The confirmation is this app's own message box: a press
 * on the device happens with no page in front, and the question must show
 * even when the dashboard does not draw.
 */
let deviceActions: DeviceActions | null = null;
function actionsNow(): DeviceActions {
    if (deviceActions) return deviceActions;
    const file = join(pluginsDir(), "device-actions.json");
    deviceActions = new DeviceActions({
        read: async () => JSON.parse(await readFile(file, "utf8")) as unknown,
        write: async (store) => {
            await mkdir(pluginsDir(), { recursive: true });
            const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(temp, JSON.stringify(store), "utf8");
            await rename(temp, file);
        },
        confirm: async (action, lines) => {
            const { response } = await dialog.showMessageBox({
                type: "question",
                title: "Run a custom action",
                message: `Run "${action.name}"?`,
                detail: `A button on your device runs this for the first time since it was set up or changed:\n\n${lines.slice(0, 20).join("\n")}${lines.length > 20 ? `\n...and ${lines.length - 20} more` : ""}\n\nPolaris asks again whenever these steps change.`,
                buttons: ["Run it", "Cancel"],
                defaultId: 1,
                cancelId: 1,
                noLink: true
            });
            return response === 0;
        },
        runner: {
            open: async (path) => (await shell.openPath(path)) === "",
            website: async (url) => {
                openExternal(url);
                return true;
            },
            // A program the person chose to open: its window is the point.
            run: (file, args) => startProgram(file, args),
            hotkey: async (step) => {
                const codes = windowsKeyCodes(step);
                return process.platform === "win32" && codes !== null ? sharedWindowsLister().sendKeys(codes) : false;
            },
            polaris: async (action) => runPluginAction(action),
            launcher: async (entry) => runLauncherEntry(entry)
        },
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        launcherLabel: (entry) => launcherEntries().find((item) => item.entry === entry)?.label
    });
    return deviceActions;
}

/** What a plugin's `polaris.action` names: a call action, a custom action or a launcher entry. */
async function runActionRef(value: string): Promise<boolean> {
    const ref = readActionRef(value);
    if (!ref) return false;
    if (ref.kind === "call") return runPluginAction(ref.action);
    if (ref.kind === "launcher") return runLauncherEntry(ref.entry);
    const outcome = await actionsNow().run(ref.id);
    if (outcome === "failed") showNotice({ title: "A custom action did not finish", body: "One of its steps did not go through. Open the device's page to check it.", tag: "device-action", silent: true });
    return outcome === "ran";
}

/** Each running plugin's newest live values, for a page that opens after they came. */
const liveValues = new Map<string, PluginLive>();

function broadcast(channel: string, ...args: unknown[]): void {
    for (const contents of webContents.getAllWebContents()) if (!contents.isDestroyed()) contents.send(channel, ...args);
}

/**
 * The scheme plugin views load from, made a standard, secure one so a frame on
 * the Polaris page can show it. Electron takes this only before the app is ready.
 */
/**
 * Answer a channel under its name and the one it had before the rename
 * (`desktop:addons-*`). Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
    ipcMain.handle(channel, listener);
    ipcMain.handle(channel.replace("desktop:plugins-", "desktop:addons-"), listener);
}

export function registerPluginViewScheme(): void {
    protocol.registerSchemesAsPrivileged(VIEW_SCHEMES.map((scheme) => ({ scheme, privileges: { standard: true, secure: true } })));
}

/** An installed plugin that ships a view, with where its files are, or null. */
async function viewOf(id: string): Promise<{ root: string; view: string; granted: readonly (typeof PLUGIN_PERMISSIONS)[number][] } | null> {
    const found = (await manager?.snapshot())?.installed.find((plugin) => plugin.id === id);
    if (!found?.manifest?.view) return null;
    return { root: packageDir(pluginsDir(), id, found.version), view: found.manifest.view, granted: found.granted };
}

/** Serve views out of their package folder only, under a policy that reaches nothing else. */
function servePluginViews(): void {
    const refuse = () => new Response(null, { status: 404 });
    const serve = async (request: Request): Promise<Response> => {
        const asked = readViewUrl(request.url);
        if (!asked || request.method !== "GET") return refuse();
        const found = await viewOf(asked.id);
        const file = found ? resolveViewFile(found.root, found.view, asked.path) : null;
        const type = file ? viewContentType(file) : null;
        if (!file || !type) return refuse();
        try {
            return new Response(await readFile(file), {
                headers: { "content-type": type, "content-security-policy": VIEW_CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" }
            });
        } catch {
            return refuse();
        }
    };
    for (const scheme of VIEW_SCHEMES) protocol.handle(scheme, serve);
}

export function startDevicePlugins(showPolaris: (path?: string) => void, games: () => readonly string[] = () => []): PluginManager {
    if (manager) return manager;
    runningGames = games;
    const created = createPluginManager({
        dir: pluginsDir(),
        platform: pluginPlatform(process.platform, process.arch),
        appVersion: app.getVersion(),
        fetcher: (url, init) => net.fetch(url, init),
        locale: () => app.getLocale(),
        fork,
        onLive: (id, live) => {
            liveValues.set(id, live);
            broadcast(CHANNELS.pluginsLive, id, live);
        },
        call: async (id, method, params) => {
            if (method === "settings.get") return manager?.settings(id) ?? null;
            if (method === "polaris.state") return { call: voiceStateNow(), games: runningGames() };
            if (method === "system.launchOfficial") return launchOfficial(id);
            // judgeCall checked the shape: a call action, or a custom or launcher one.
            return runActionRef((params as { action: string }).action);
        },
        devices: () => devices,
        offer: (entry, deviceName) => {
            if (!Notification.isSupported()) return;
            const notice = new Notification({ title: `${deviceName} found`, body: `Add support for it with ${entry.name}.`, silent: true });
            notice.on("click", () => {
                showPolaris();
                broadcast(CHANNELS.pluginsOpen, entry.id);
            });
            notice.show();
        },
        notify: (id, news) => {
            // An update can bring a requirement the install never had: it is set up now, not on the next start.
            if (news.kind === "updated") void ensureRequirements("install", id);
            const words = newsWords(news);
            showNotice({
                title: words.title,
                body: words.body,
                tag: `plugin-update:${id}`,
                silent: true,
                onClick: () => {
                    showPolaris();
                    broadcast(CHANNELS.pluginsOpen, id);
                }
            });
        },
        onChange: () => {
            broadcast(CHANNELS.pluginsChanged);
            lookAtShortcuts(showPolaris);
        },
        log: (id, level, text) => console[level === "info" ? "log" : level](`[plugin ${id}] ${text}`),
        // Kept on disk (`logs/perf.log`): the console above is gone once the app closes.
        record: perfEvent,
        // The microphone and the app in front are read through the game watcher's shell, which only Windows has.
        profileReads: { meeting: process.platform === "win32", front: process.platform === "win32" }
    });
    manager = created;
    watchProfileSignals(
        {
            inCall: () => voiceStateNow() !== null,
            games: () => runningGames(),
            glance: process.platform === "win32" ? () => sharedWindowsLister().glance() : null,
            needs: () => created.profileNeeds(),
            ownPath: process.execPath,
            push: (signals) => void created.profileSignals(signals).catch(() => undefined)
        },
        (tick, ms) => {
            const timer = setInterval(tick, ms);
            timer.unref();
            return () => clearInterval(timer);
        }
    );
    const keptAt = join(pluginsDir(), "requirements.json");
    requirements = createRequirements({
        platform: pluginPlatform(process.platform, process.arch),
        runnerFor: (id, key) => {
            const runner = requirementRunnerFor(id, key, pluginsDir());
            // The driver swap needs the device free: the plugin lets it go meanwhile and starts again after.
            return runner && key === DRIVER_REQUIREMENT ? { look: () => runner.look(), setUp: () => created.whileStopped(id, () => runner.setUp()) } : runner;
        },
        read: async () => JSON.parse(await readFile(keptAt, "utf8")),
        async write(value) {
            const temp = `${keptAt}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(temp, JSON.stringify(value), "utf8");
            await rename(temp, keptAt);
        },
        changed: () => broadcast(CHANNELS.pluginsChanged),
        restored: (id, requirement) => {
            void installedManifest(id).then((found) =>
                showNotice({
                    title: found?.name ?? id,
                    body: pluginText(requirement.restored ?? requirement.label, app.getLocale()),
                    tag: `plugin-requirement:${id}`,
                    silent: true,
                    onClick: () => {
                        showPolaris();
                        broadcast(CHANNELS.pluginsOpen, id);
                    }
                })
            );
        }
    });
    servePluginViews();
    if (process.platform === "win32") {
        collisions = createCollisionWatch({
            // Plugged in and switched on; where plugs cannot be heard, every installed one.
            watched: () => (devices ? shortcuts.plugged : shortcuts.installed).map((item) => item.id),
            // The game watcher's open shell; a look that does not answer is skipped rather than paid for with `tasklist`.
            list: () => sharedWindowsLister().list(false),
            driver: (id) => driverRunnerFor(id, pluginsDir())?.knownState() ?? null,
            changed: () => broadcast(CHANNELS.pluginsChanged)
        });
        collisions.start();
    }
    usb = watchUsb((next) => {
        devices = next;
        void created.devicesChanged(next).finally(() => {
            lookAtShortcuts(showPolaris);
            void collisions?.tick();
        });
        // A device plugged in with another driver on it gets the plugin's back.
        void ensureRequirements("plugged");
    });
    if (usb) devices = usb.list();
    void created
        .start()
        .finally(() => lookAtShortcuts(showPolaris))
        .then(() => ensureRequirements("start"));
    created.startUpdates();
    return created;
}

export function stopDevicePlugins(): void {
    usb?.close();
    usb = null;
    collisions?.stop();
    collisions = null;
    manager?.stop();
}

const idSchema = pluginIdSchema;

/** The bridge's channels; `allowed` is the host's check that the asking page is the Polaris one. */
export function registerPluginIpc(
    allowed: (event: IpcMainInvokeEvent) => boolean,
    showPolaris: (path?: string) => void
): void {
    const ready = () => startDevicePlugins(showPolaris);
    const keySchema = requirementKeySchema;
    /** After an install whose consent listed `requires`: keep the consent, then set them up (the permission prompt comes now). */
    const installedWith = async (id: string, requires: readonly string[]) => {
        const listed = new Set(pluginRequirements((await installedManifest(id)) ?? { requires: {} }, pluginPlatform(process.platform, process.arch)).map((item) => item.key));
        await requirements?.consent(id, requires.filter((key) => listed.has(key)));
        void ensureRequirements("install", id);
    };
    handle(CHANNELS.pluginsGet, (event) => (allowed(event) ? snapshotWithActions(ready()) : null));
    handle(CHANNELS.pluginsLiveGet, (event, id: unknown) => (allowed(event) && typeof id === "string" ? (liveValues.get(id) ?? null) : null));
    handle(CHANNELS.pluginsRefresh, async (event) => (allowed(event) ? ready().refresh() : null));
    // Every path answers (install-call.ts): a stuck or failed update comes back to the page as a reason it can say.
    handle(CHANNELS.pluginsInstall, (event, id: unknown, accepted: unknown, requires: unknown) =>
        answerInstall(
            {
                allowed: allowed(event),
                install: (plugin, permissions) => ready().install(plugin, permissions),
                installedWith,
                log: (text) => console.warn(`[plugins] ${text}`)
            },
            id,
            accepted,
            requires
        )
    );
    // One of the actions the snapshot offers for an installed plugin (`InstalledPlugin.actions`).
    handle(CHANNELS.pluginsAction, async (event, id: unknown, action: unknown) => {
        const parsedId = idSchema.safeParse(id);
        const parsedAction = keySchema.safeParse(action);
        if (!allowed(event) || !parsedId.success || !parsedAction.success) return false;
        ready();
        const found = await installedManifest(parsedId.data);
        const held = requirements;
        if (found && parsedAction.data === TAKE_OVER_ACTION) return collisions?.holding(parsedId.data) ? takeOver(ready(), parsedId.data, found) : false;
        if (!found || !held) return false;
        // After any automatic setup already under way, so only one prompt is open.
        const run = ensuring.then(() => held.run(parsedId.data, found, parsedAction.data));
        ensuring = run.then(() => undefined, () => undefined);
        return run.catch(() => false);
    });
    handle(CHANNELS.pluginsUninstall, async (event, id: unknown) => {
        const parsed = idSchema.safeParse(id);
        if (!allowed(event) || !parsed.success) return false;
        // The Stream 100's own driver goes with it: our certificate out of the
        // machine's stores and the driver the device had before put back. A
        // declined prompt keeps the plugin, so nothing is left half removed.
        const driver = driverRunnerFor(parsed.data, pluginsDir());
        if (driver && (await driver.installed())) {
            const removed = await driver.remove();
            if (!removed.ok) return false;
        }
        // On Linux the udev rule goes too; a declined prompt only leaves a harmless rule behind.
        const udev = udevRunnerFor(parsed.data);
        if (udev && (await udev.installed())) await udev.remove().catch(() => undefined);
        await ready().uninstall(parsed.data);
        await requirements?.forget(parsed.data);
        return true;
    });
    handle(CHANNELS.pluginsEnable, (event, id: unknown, enabled: unknown) => {
        const parsed = idSchema.safeParse(id);
        if (!allowed(event) || !parsed.success || typeof enabled !== "boolean") return false;
        return ready().setEnabled(parsed.data, enabled);
    });
    handle(CHANNELS.pluginsSettings, (event, id: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? ready().settings(parsed.data) : null;
    });
    // What a plugin's view asks, through the page that holds its frame.
    handle(CHANNELS.pluginsViewCall, async (event, id: unknown, method: unknown, params: unknown) => {
        const parsed = idSchema.safeParse(id);
        if (!allowed(event) || !parsed.success || typeof method !== "string") return { ok: false, error: "permission" };
        const running = ready();
        const found = await viewOf(parsed.data);
        if (!found) return { ok: false, error: "permission" };
        const verdict = judgeViewCall(found.granted, method, params);
        if (!verdict.ok) return verdict;
        try {
            if (verdict.kind === "set") {
                const values = await running.setSetting(parsed.data, verdict.key, verdict.value);
                return values ? { ok: true, value: values } : { ok: false, error: "bad-params" };
            }
            // Only the Stream 100 has a driver of its own; any other view gets null.
            if (verdict.kind === "driver") return { ok: true, value: await lookDriver(driverRunnerFor(parsed.data, pluginsDir()), requirements?.failure(parsed.data, DRIVER_REQUIREMENT) ?? null) };
            if (verdict.method === "settings.get") return { ok: true, value: await running.settings(parsed.data) };
            if (verdict.method === "polaris.state") return { ok: true, value: { call: voiceStateNow(), games: runningGames() } };
            if (verdict.method === "system.launchOfficial") return { ok: true, value: await launchOfficial(parsed.data) };
            // A view's button runs what a device button does, custom actions asking first just the same.
            return { ok: true, value: await runActionRef((verdict.params as { action: string }).action) };
        } catch {
            return { ok: false, error: "failed" };
        }
    });
    handle(CHANNELS.pluginsOfficial, async (event, id: unknown, request: unknown) => {
        const parsedId = idSchema.safeParse(id);
        const parsedRequest = officialRequestSchema.safeParse(request);
        if (!allowed(event) || !parsedId.success || !parsedRequest.success) return null;
        const runner = officialRunnerFor(parsedId.data, pluginsDir());
        if (!runner) return null;
        const dataDir = join(pluginsDir(), "official", parsedId.data);
        try {
            return await answerOfficial(
                runner,
                ready(),
                parsedId.data,
                parsedRequest.data,
                async (name, text) => {
                    await mkdir(dataDir, { recursive: true });
                    await writeFile(join(dataDir, name), text, "utf8");
                },
                (requires) => installedWith(parsedId.data, requires),
                // The last look, never a new one: this answers every time the page opens.
                async () => (await driverRunnerFor(parsedId.data, pluginsDir())?.lastState())?.state === "installed"
            );
        } catch (error) {
            console.error(`[plugin ${parsedId.data}] official software: ${error instanceof Error ? error.message : String(error)}`);
            return { ok: false, reason: "failed" };
        }
    });
    handle(CHANNELS.pluginsSetAutoUpdate, (event, id: unknown, value: unknown) => {
        const parsedId = z.union([idSchema, z.null()]).safeParse(id);
        const parsedValue = z.boolean().nullable().safeParse(value);
        if (!allowed(event) || !parsedId.success || !parsedValue.success) return false;
        return ready().setAutoUpdate(parsedId.data, parsedValue.data);
    });
    // The custom actions, edited from the plugin's page; every request is checked here and a run still asks first.
    ipcMain.handle(CHANNELS.deviceActions, async (event, request: unknown) => {
        const parsed = deviceActionRequestSchema.safeParse(request);
        if (!allowed(event) || !parsed.success) return { ok: false, error: "bad-request" };
        const actions = actionsNow();
        switch (parsed.data.kind) {
            case "list":
                return { ok: true, value: { actions: await actions.list(), launcher: launcherEntries(), hotkeys: process.platform === "win32" ? null : "unsupported" } };
            case "save":
                return (await actions.save(parsed.data.action)) ? { ok: true } : { ok: false, error: "bad-request" };
            case "remove":
                return { ok: await actions.remove(parsed.data.id) };
            case "run":
                return { ok: true, value: await actions.run(parsed.data.id) };
            case "pick": {
                const what = parsed.data.what;
                const picked = await dialog.showOpenDialog({
                    properties: [what === "folder" ? "openDirectory" : "openFile"],
                    ...(what === "program" && process.platform === "win32" ? { filters: [{ name: "Programs", extensions: ["exe", "bat", "cmd", "lnk"] }, { name: "All files", extensions: ["*"] }] } : {})
                });
                return { ok: true, value: picked.canceled ? null : (picked.filePaths[0] ?? null) };
            }
        }
    });
    handle(CHANNELS.pluginsProfile, (event, id: unknown, request: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? ready().profile(parsed.data, request) : { ok: false, error: "bad-request" };
    });
    handle(CHANNELS.pluginsSetSetting, (event, id: unknown, key: unknown, value: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? ready().setSetting(parsed.data, key, value) : null;
    });
}
