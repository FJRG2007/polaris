/**
 * The plugin manager in the running app: utility processes, `net.fetch`, the
 * USB watch, the "found a device" notice, and the bridge the host's Settings
 * draws the store from (`window.polarisDesktop.plugins`).
 */

import { z } from "zod";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { packageDir, pluginsFolder } from "./packages";
import { judgeViewCall, readViewUrl, resolveViewFile, viewContentType, VIEW_CSP, VIEW_SCHEMES } from "./view";
import { CHANNELS } from "@/shared/bridge";
import type { PluginAction } from "@/shared/plugin-protocol";
import { setTrayPlugins } from "../tray";
import { watchUsb, type UsbWatch } from "./presence";
import { pluginShortcuts, sameShortcuts, type PluginShortcuts } from "./ways-in";
import type { PluginChild, WantedPlugin } from "./supervisor";
import { createPluginManager, type PluginManager } from "./manager";
import { answerOfficial, createDriverSetting, driverRunnerFor, officialRequestSchema, officialRunnerFor } from "./official";
import { showNotice } from "../notices";
import { newsWords } from "./updates";
import { callPageAction, voiceStateNow, voiceWidgetAction } from "../voice-widget";
import { PLUGIN_PERMISSIONS, pluginPlatform, type UsbDevice } from "@polaris/core/device-plugins";
import { app, ipcMain, net, Notification, protocol, utilityProcess, webContents, type IpcMainInvokeEvent } from "electron";

let manager: PluginManager | null = null;
let usb: UsbWatch | null = null;
let devices: UsbDevice[] | null = null;
let shortcuts: PluginShortcuts = { installed: [], plugged: [] };
/** Whether a look at the installed plugins is under way, and whether another was asked for meanwhile. */
let looking: Promise<void> | null = null;
let lookAgain = false;

let folder: string | null = null;
/** Resolved once: the first call moves a folder from before the rename (`pluginsFolder`). */
const pluginsDir = (): string => (folder ??= pluginsFolder(app.getPath("userData")));

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

export function startDevicePlugins(showPolaris: (path?: string) => void): PluginManager {
    if (manager) return manager;
    const created = createPluginManager({
        dir: pluginsDir(),
        platform: pluginPlatform(process.platform, process.arch),
        appVersion: app.getVersion(),
        fetcher: (url, init) => net.fetch(url, init),
        fork,
        call: async (id, method, params) => {
            if (method === "settings.get") return manager?.settings(id) ?? null;
            if (method === "polaris.state") return { call: voiceStateNow() };
            if (method === "system.launchOfficial") return launchOfficial(id);
            // judgeCall checked the shape: one of PLUGIN_ACTIONS.
            return runPluginAction((params as { action: PluginAction }).action);
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
        log: (id, level, text) => console[level === "info" ? "log" : level](`[plugin ${id}] ${text}`)
    });
    manager = created;
    servePluginViews();
    usb = watchUsb((next) => {
        devices = next;
        void created.devicesChanged(next).finally(() => lookAtShortcuts(showPolaris));
    });
    if (usb) devices = usb.list();
    void created.start().finally(() => lookAtShortcuts(showPolaris));
    created.startUpdates();
    return created;
}

export function stopDevicePlugins(): void {
    usb?.close();
    usb = null;
    manager?.stop();
}

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);

/** The bridge's channels; `allowed` is the host's check that the asking page is the Polaris one. */
export function registerPluginIpc(
    allowed: (event: IpcMainInvokeEvent) => boolean,
    showPolaris: (path?: string) => void
): void {
    const ready = () => startDevicePlugins(showPolaris);
    // Settings change through here so the Stream 100's driver setting sets the driver up or takes it out.
    const driverSetting = createDriverSetting(
        { settings: (id) => ready().settings(id), setSetting: (id, key, value) => ready().setSetting(id, key, value) },
        (id) => driverRunnerFor(id, pluginsDir())
    );
    handle(CHANNELS.pluginsGet, (event) => (allowed(event) ? ready().snapshot() : null));
    handle(CHANNELS.pluginsRefresh, async (event) => {
        if (allowed(event)) await ready().refresh();
    });
    handle(CHANNELS.pluginsInstall, (event, id: unknown, accepted: unknown) => {
        const parsedId = idSchema.safeParse(id);
        const parsedAccepted = z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).safeParse(accepted);
        if (!allowed(event) || !parsedId.success || !parsedAccepted.success) return { ok: false, reason: "refused" };
        return ready().install(parsedId.data, parsedAccepted.data);
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
        await ready().uninstall(parsed.data);
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
                const values = await driverSetting.set(parsed.data, verdict.key, verdict.value);
                return values ? { ok: true, value: values } : { ok: false, error: "bad-params" };
            }
            // Only the Stream 100 has a driver of its own; any other view gets null.
            if (verdict.kind === "driver") return { ok: true, value: await driverSetting.look(parsed.data) };
            if (verdict.method === "settings.get") return { ok: true, value: await running.settings(parsed.data) };
            if (verdict.method === "polaris.state") return { ok: true, value: { call: voiceStateNow() } };
            if (verdict.method === "system.launchOfficial") return { ok: true, value: await launchOfficial(parsed.data) };
            return { ok: true, value: runPluginAction((verdict.params as { action: PluginAction }).action) };
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
            return await answerOfficial(runner, ready(), parsedId.data, parsedRequest.data, async (name, text) => {
                await mkdir(dataDir, { recursive: true });
                await writeFile(join(dataDir, name), text, "utf8");
            });
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
    handle(CHANNELS.pluginsSetSetting, (event, id: unknown, key: unknown, value: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? driverSetting.set(parsed.data, key, value) : null;
    });
}
