/**
 * The bridge for the pages this app draws itself: `window.polarisLocal`.
 *
 * The main process answers each channel only for the kind of window it belongs
 * to, so the address form cannot start a push and the push window cannot read
 * the key form's state.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type PolarisLocal, type PushEvent } from "@/shared/bridge";

const bridge: PolarisLocal = {
    connect: {
        state: () => ipcRenderer.invoke(CHANNELS.connectState),
        submit: (address) => ipcRenderer.invoke(CHANNELS.connectSubmit, address)
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
    }
};

contextBridge.exposeInMainWorld("polarisLocal", bridge);
