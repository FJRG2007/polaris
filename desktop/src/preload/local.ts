/**
 * The bridge for the pages this app draws itself: `window.polarisLocal`.
 *
 * The main process answers each channel only for the kind of window it belongs
 * to, so the address form cannot start a push and the push window cannot read
 * the key form's state.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { readUpdateCheck } from "@/shared/update-check";
import type { StrokeInput } from "@/shared/annotate";
import type { WidgetView } from "@/shared/voice-widget";
import { applyTextSize } from "./text-size";
import { CHANNELS, type PolarisLocal, type PushEvent, type TvInstallState } from "@/shared/bridge";

const bridge: PolarisLocal = {
    connect: {
        state: () => ipcRenderer.invoke(CHANNELS.connectState),
        submit: (address, name) => ipcRenderer.invoke(CHANNELS.connectSubmit, { address, name: name ?? "" }),
        check: (address) => ipcRenderer.invoke(CHANNELS.connectCheck, address),
        switchTo: (origin) => ipcRenderer.invoke(CHANNELS.connectSwitch, origin),
        rename: (origin, name) => ipcRenderer.invoke(CHANNELS.connectRename, { origin, name }),
        edit: (origin, address, name) => ipcRenderer.invoke(CHANNELS.connectEdit, { origin, address, name }),
        remove: (origin) => ipcRenderer.invoke(CHANNELS.connectRemove, origin),
        copyHosts: () => ipcRenderer.invoke(CHANNELS.connectHostsCopy),
        exportHostsFile: () => ipcRenderer.invoke(CHANNELS.connectHostsExport),
        importHostsFile: () => ipcRenderer.invoke(CHANNELS.connectHostsOpen),
        importHosts: (text) => ipcRenderer.invoke(CHANNELS.connectHostsImport, text),
        preferences: () => ipcRenderer.invoke(CHANNELS.connectPreferences),
        setOpenAtLogin: (open) => ipcRenderer.invoke(CHANNELS.connectOpenAtLogin, open),
        setHardwareAcceleration: (on) => ipcRenderer.invoke(CHANNELS.connectHardwareAcceleration, on),
        setToggle: (name, on) => ipcRenderer.invoke(CHANNELS.connectToggle, { name, on }),
        relaunch: () => ipcRenderer.invoke(CHANNELS.connectRelaunch),
        close: () => ipcRenderer.invoke(CHANNELS.connectClose),
        checkForUpdates: async () => readUpdateCheck(await ipcRenderer.invoke(CHANNELS.connectCheckUpdates)),
        updateDownloaded: async () => readUpdateCheck(await ipcRenderer.invoke(CHANNELS.connectUpdateDownloaded)),
        restartToUpdate: () => ipcRenderer.invoke(CHANNELS.connectRestart),
        openUpdatePage: () => ipcRenderer.invoke(CHANNELS.connectUpdatePage)
    },
    apiKey: {
        state: () => ipcRenderer.invoke(CHANNELS.keyState),
        submit: (key) => ipcRenderer.invoke(CHANNELS.keySubmit, key),
        cancel: () => ipcRenderer.invoke(CHANNELS.keyCancel),
        openKeys: () => ipcRenderer.invoke(CHANNELS.keyOpen)
    },
    push: {
        state: () => ipcRenderer.invoke(CHANNELS.pushState),
        chooseFolder: () => ipcRenderer.invoke(CHANNELS.pushChoose),
        start: (input) => ipcRenderer.invoke(CHANNELS.pushStart, input),
        cancel: () => ipcRenderer.invoke(CHANNELS.pushCancel),
        openService: () => ipcRenderer.invoke(CHANNELS.pushOpenService),
        onEvent: (listener) => {
            const handler = (_event: IpcRendererEvent, payload: PushEvent) => listener(payload);
            ipcRenderer.on(CHANNELS.pushEvent, handler);
            return () => ipcRenderer.removeListener(CHANNELS.pushEvent, handler);
        }
    },
    tv: {
        state: () => ipcRenderer.invoke(CHANNELS.tvState),
        find: () => ipcRenderer.invoke(CHANNELS.tvFind),
        findUsb: () => ipcRenderer.invoke(CHANNELS.tvFindUsb),
        cancel: () => ipcRenderer.invoke(CHANNELS.tvCancel),
        start: (input) => ipcRenderer.invoke(CHANNELS.tvStart, input),
        onState: (listener) => {
            const handler = (_event: IpcRendererEvent, state: TvInstallState) => listener(state);
            ipcRenderer.on(CHANNELS.tvEvent, handler);
            return () => ipcRenderer.removeListener(CHANNELS.tvEvent, handler);
        }
    },
    overlay: {
        onStroke: (listener) => {
            const handler = (_event: IpcRendererEvent, stroke: StrokeInput) => listener(stroke);
            ipcRenderer.on(CHANNELS.overlayStroke, handler);
            return () => ipcRenderer.removeListener(CHANNELS.overlayStroke, handler);
        }
    },
    voiceWidget: {
        onView: (listener) => {
            const handler = (_event: IpcRendererEvent, view: WidgetView | null) => listener(view);
            ipcRenderer.on(CHANNELS.widgetView, handler);
            return () => ipcRenderer.removeListener(CHANNELS.widgetView, handler);
        },
        act: (action) => ipcRenderer.invoke(CHANNELS.widgetAction, action)
    }
};

contextBridge.exposeInMainWorld("polarisLocal", bridge);

// Every window of the app's own reads at the account's text size, asked for
// before the page draws: an answer that came back after the first paint would
// lay the window out at the default size and then redraw it at this one.
const size: unknown = ipcRenderer.sendSync(CHANNELS.textSize);
if (typeof size === "number") applyTextSize(size);
ipcRenderer.on(CHANNELS.textSizeChanged, (_event: unknown, size: unknown) => {
    if (typeof size === "number") applyTextSize(size);
});
