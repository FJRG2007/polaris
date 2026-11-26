/**
 * The launcher page's bridge, `window.polarisLauncher`: eight calls and nothing
 * else - the same for the window's own panel and for the instance's `/launcher`
 * page (main checks which page is asking), so the preload stays small (`shared/launcher` bundles to its channel
 * names; its ranking is tree-shaken out).
 */

import { contextBridge, ipcRenderer } from "electron";
import { LAUNCHER_CHANNELS, type PolarisLauncher } from "@/shared/launcher";

const bridge: PolarisLauncher = {
    query: (text, mode) => ipcRenderer.invoke(LAUNCHER_CHANNELS.query, text, mode),
    open: (href) => ipcRenderer.invoke(LAUNCHER_CHANNELS.open, href),
    run: (id) => ipcRenderer.invoke(LAUNCHER_CHANNELS.run, id),
    hide: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.hide),
    clearClipboard: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.clearClipboard),
    addons: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.addons),
    onOpened: (listener) => {
        ipcRenderer.on(LAUNCHER_CHANNELS.opened, (_event, query: unknown) => listener(typeof query === "string" ? query : ""));
    },
    onHidden: (listener) => {
        ipcRenderer.on(LAUNCHER_CHANNELS.hidden, () => listener());
    }
};

contextBridge.exposeInMainWorld("polarisLauncher", bridge);
