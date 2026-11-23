/**
 * The launcher page's bridge, `window.polarisLauncher`: five calls and nothing
 * else, so the preload stays small (`shared/launcher` bundles to its channel
 * names; its ranking is tree-shaken out).
 */

import { contextBridge, ipcRenderer } from "electron";
import { LAUNCHER_CHANNELS, type PolarisLauncher } from "@/shared/launcher";

const bridge: PolarisLauncher = {
    query: (text) => ipcRenderer.invoke(LAUNCHER_CHANNELS.query, text),
    run: (id) => ipcRenderer.invoke(LAUNCHER_CHANNELS.run, id),
    hide: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.hide),
    clearClipboard: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.clearClipboard),
    onOpened: (listener) => {
        ipcRenderer.on(LAUNCHER_CHANNELS.opened, () => listener());
    }
};

contextBridge.exposeInMainWorld("polarisLauncher", bridge);
