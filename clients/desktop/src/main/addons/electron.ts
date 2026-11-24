/**
 * The add-on manager in the running app: utility processes, `net.fetch`, the
 * USB watch, the "found a device" notice, and the bridge the host's Settings
 * draws the store from (`window.polarisDesktop.addons`).
 */

import { z } from "zod";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { packageDir } from "./packages";
import { judgeViewCall, readViewUrl, resolveViewFile, viewContentType, VIEW_CSP, VIEW_SCHEME } from "./view";
import { CHANNELS } from "@/shared/bridge";
import type { AddonAction } from "@/shared/addon-protocol";
import { setTrayAddons } from "../tray";
import { watchUsb, type UsbWatch } from "./presence";
import { addonShortcuts, localAddonRows, sameShortcuts, type AddonShortcuts } from "./ways-in";
import type { AddonChild, WantedAddon } from "./supervisor";
import { createAddonManager, type AddonManager } from "./manager";
import { callPageAction, voiceStateNow, voiceWidgetAction } from "../voice-widget";
import { ADDON_PERMISSIONS, addonPlatform, type UsbDevice } from "@polaris/core/device-addons";
import { app, ipcMain, net, Notification, protocol, utilityProcess, webContents, type IpcMainInvokeEvent } from "electron";

let manager: AddonManager | null = null;
let usb: UsbWatch | null = null;
let devices: UsbDevice[] | null = null;
let shortcuts: AddonShortcuts = { installed: [], plugged: [] };
/** Whether a look at the installed add-ons is under way, and whether another was asked for meanwhile. */
let looking: Promise<void> | null = null;
let lookAgain = false;

/** Every installed add-on, for the launcher's "Configure <name>" rows. Empty until the manager has started. */
export function addonShortcutsNow(): AddonShortcuts {
    return shortcuts;
}

/**
 * Read what is installed and plugged again and put the tray's add-on items up
 * to date. One look at a time; a change heard during one is looked at after it.
 */
function lookAtShortcuts(show: (path?: string) => void): void {
    if (looking) {
        lookAgain = true;
        return;
    }
    looking = (async () => {
        if (!manager) return;
        const next = addonShortcuts((await manager.snapshot()).installed, devices);
        const trayChanged = !sameShortcuts(next.plugged, shortcuts.plugged);
        shortcuts = next;
        if (trayChanged) {
            setTrayAddons(next.plugged, (id) => {
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

/** Only what a native module needs to load: the add-on gets none of the app's own environment. */
function addonEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "LANG", "XDG_RUNTIME_DIR"]) {
        const value = process.env[key];
        if (value) env[key] = value;
    }
    return env;
}

function fork(wanted: WantedAddon): AddonChild {
    const child = utilityProcess.fork(wanted.entryPath, [], {
        serviceName: `Polaris add-on: ${wanted.manifest.name}`,
        stdio: "ignore",
        cwd: join(wanted.entryPath, ".."),
        env: addonEnv()
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
 * One of ADDON_ACTIONS, done by the page holding the call. Mute, deafen and
 * hanging up go the way the voice widget's buttons do, which every page that
 * reports a call understands; the camera and the screen go on a channel of
 * their own, so a page older than it hears nothing rather than something else.
 */
function runAddonAction(action: AddonAction): boolean {
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
 * The scheme add-on views load from, made a standard, secure one so a frame on
 * the Polaris page can show it. Electron takes this only before the app is ready.
 */
export function registerAddonViewScheme(): void {
    protocol.registerSchemesAsPrivileged([{ scheme: VIEW_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** An installed add-on that ships a view, with where its files are, or null. */
async function viewOf(id: string): Promise<{ root: string; view: string; granted: readonly (typeof ADDON_PERMISSIONS)[number][] } | null> {
    const found = (await manager?.snapshot())?.installed.find((addon) => addon.id === id);
    if (!found?.manifest?.view) return null;
    return { root: packageDir(join(app.getPath("userData"), "addons"), id, found.version), view: found.manifest.view, granted: found.granted };
}

/** Serve views out of their package folder only, under a policy that reaches nothing else. */
function serveAddonViews(): void {
    const refuse = () => new Response(null, { status: 404 });
    protocol.handle(VIEW_SCHEME, async (request) => {
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
    });
}

export function startDeviceAddons(showPolaris: (path?: string) => void): AddonManager {
    if (manager) return manager;
    const created = createAddonManager({
        dir: join(app.getPath("userData"), "addons"),
        platform: addonPlatform(process.platform, process.arch),
        appVersion: app.getVersion(),
        fetcher: (url, init) => net.fetch(url, init),
        fork,
        call: async (id, method, params) => {
            if (method === "settings.get") return manager?.settings(id) ?? null;
            if (method === "polaris.state") return { call: voiceStateNow() };
            // judgeCall checked the shape: one of ADDON_ACTIONS.
            return runAddonAction((params as { action: AddonAction }).action);
        },
        devices: () => devices,
        offer: (entry, deviceName) => {
            if (!Notification.isSupported()) return;
            const notice = new Notification({ title: `${deviceName} found`, body: `Add support for it with ${entry.name}.`, silent: true });
            notice.on("click", () => {
                showPolaris();
                broadcast(CHANNELS.addonsOpen, entry.id);
            });
            notice.show();
        },
        onChange: () => {
            broadcast(CHANNELS.addonsChanged);
            lookAtShortcuts(showPolaris);
        },
        log: (id, level, text) => console[level === "info" ? "log" : level](`[add-on ${id}] ${text}`)
    });
    manager = created;
    serveAddonViews();
    usb = watchUsb((next) => {
        devices = next;
        void created.devicesChanged(next).finally(() => lookAtShortcuts(showPolaris));
    });
    if (usb) devices = usb.list();
    void created.start().finally(() => lookAtShortcuts(showPolaris));
    return created;
}

export function stopDeviceAddons(): void {
    usb?.close();
    usb = null;
    manager?.stop();
}

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);

/** The bridge's channels; `allowed` is the host's check that the asking page is the Polaris one. */
export function registerAddonIpc(
    allowed: (event: IpcMainInvokeEvent) => boolean,
    showPolaris: (path?: string) => void,
    /** The app's own settings page, which lists the installed add-ons and turns them on and off, offline too. */
    local: (event: IpcMainInvokeEvent) => boolean = () => false
): void {
    const ready = () => startDeviceAddons(showPolaris);
    ipcMain.handle(CHANNELS.connectAddons, async (event) => (local(event) ? localAddonRows((await ready().snapshot()).installed) : []));
    ipcMain.handle(CHANNELS.connectAddonEnable, (event, id: unknown, enabled: unknown) => {
        const parsed = idSchema.safeParse(id);
        if (!local(event) || !parsed.success || typeof enabled !== "boolean") return false;
        return ready().setEnabled(parsed.data, enabled);
    });
    ipcMain.handle(CHANNELS.addonsGet, (event) => (allowed(event) ? ready().snapshot() : null));
    ipcMain.handle(CHANNELS.addonsRefresh, async (event) => {
        if (allowed(event)) await ready().refresh();
    });
    ipcMain.handle(CHANNELS.addonsInstall, (event, id: unknown, accepted: unknown) => {
        const parsedId = idSchema.safeParse(id);
        const parsedAccepted = z.array(z.enum(ADDON_PERMISSIONS)).max(ADDON_PERMISSIONS.length).safeParse(accepted);
        if (!allowed(event) || !parsedId.success || !parsedAccepted.success) return { ok: false, reason: "refused" };
        return ready().install(parsedId.data, parsedAccepted.data);
    });
    ipcMain.handle(CHANNELS.addonsUninstall, async (event, id: unknown) => {
        const parsed = idSchema.safeParse(id);
        if (!allowed(event) || !parsed.success) return false;
        await ready().uninstall(parsed.data);
        return true;
    });
    ipcMain.handle(CHANNELS.addonsEnable, (event, id: unknown, enabled: unknown) => {
        const parsed = idSchema.safeParse(id);
        if (!allowed(event) || !parsed.success || typeof enabled !== "boolean") return false;
        return ready().setEnabled(parsed.data, enabled);
    });
    ipcMain.handle(CHANNELS.addonsSettings, (event, id: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? ready().settings(parsed.data) : null;
    });
    // What an add-on's view asks, through the page that holds its frame.
    ipcMain.handle(CHANNELS.addonsViewCall, async (event, id: unknown, method: unknown, params: unknown) => {
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
            if (verdict.method === "settings.get") return { ok: true, value: await running.settings(parsed.data) };
            if (verdict.method === "polaris.state") return { ok: true, value: { call: voiceStateNow() } };
            return { ok: true, value: runAddonAction((verdict.params as { action: AddonAction }).action) };
        } catch {
            return { ok: false, error: "failed" };
        }
    });
    ipcMain.handle(CHANNELS.addonsSetSetting, (event, id: unknown, key: unknown, value: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? ready().setSetting(parsed.data, key, value) : null;
    });
}

