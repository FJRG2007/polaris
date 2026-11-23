/**
 * The add-on manager in the running app: utility processes, `net.fetch`, the
 * USB watch, the "found a device" notice, and the bridge the host's Settings
 * draws the store from (`window.polarisDesktop.addons`).
 */

import { z } from "zod";
import { join } from "node:path";
import { CHANNELS } from "@/shared/bridge";
import type { AddonAction } from "@/shared/addon-protocol";
import { watchUsb, type UsbWatch } from "./presence";
import type { AddonChild, WantedAddon } from "./supervisor";
import { createAddonManager, type AddonManager } from "./manager";
import { callPageAction, voiceStateNow, voiceWidgetAction } from "../voice-widget";
import { ADDON_PERMISSIONS, addonPlatform, type UsbDevice } from "@polaris/core/device-addons";
import { app, ipcMain, net, Notification, utilityProcess, webContents, type IpcMainInvokeEvent } from "electron";

let manager: AddonManager | null = null;
let usb: UsbWatch | null = null;
let devices: UsbDevice[] | null = null;

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

export function startDeviceAddons(showPolaris: () => void): AddonManager {
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
        onChange: () => broadcast(CHANNELS.addonsChanged),
        log: (id, level, text) => console[level === "info" ? "log" : level](`[add-on ${id}] ${text}`)
    });
    manager = created;
    usb = watchUsb((next) => {
        devices = next;
        void created.devicesChanged(next);
    });
    if (usb) devices = usb.list();
    void created.start();
    return created;
}

export function stopDeviceAddons(): void {
    usb?.close();
    usb = null;
    manager?.stop();
}

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);

/** The bridge's channels; `allowed` is the host's check that the asking page is the Polaris one. */
export function registerAddonIpc(allowed: (event: IpcMainInvokeEvent) => boolean, showPolaris: () => void): void {
    const ready = () => startDeviceAddons(showPolaris);
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
    ipcMain.handle(CHANNELS.addonsSetSetting, (event, id: unknown, key: unknown, value: unknown) => {
        const parsed = idSchema.safeParse(id);
        return allowed(event) && parsed.success ? ready().setSetting(parsed.data, key, value) : null;
    });
}

