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
import { CHANNELS, type PolarisLocal, type PushEvent, type TvInstallState } from "@/shared/bridge";

const bridge: PolarisLocal = {
    connect: {
        state: () => ipcRenderer.invoke(CHANNELS.connectState),
        submit: (address, name) => ipcRenderer.invoke(CHANNELS.connectSubmit, { address, name: name ?? "" }),
        check: (address) => ipcRenderer.invoke(CHANNELS.connectCheck, address),
        switchTo: (origin) => ipcRenderer.invoke(CHANNELS.connectSwitch, origin),
        rename: (origin, name) => ipcRenderer.invoke(CHANNELS.connectRename, { origin, name }),
        remove: (origin) => ipcRenderer.invoke(CHANNELS.connectRemove, origin),
        preferences: () => ipcRenderer.invoke(CHANNELS.connectPreferences),
        setOpenAtLogin: (open) => ipcRenderer.invoke(CHANNELS.connectOpenAtLogin, open),
        setHardwareAcceleration: (on) => ipcRenderer.invoke(CHANNELS.connectHardwareAcceleration, on),
        relaunch: () => ipcRenderer.invoke(CHANNELS.connectRelaunch),
        close: () => ipcRenderer.invoke(CHANNELS.connectClose),
        checkForUpdates: async () => readUpdateCheck(await ipcRenderer.invoke(CHANNELS.connectCheckUpdates)),
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
    }
};

contextBridge.exposeInMainWorld("polarisLocal", bridge);
