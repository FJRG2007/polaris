/**
 * The launcher page's bridge, `window.polarisLauncher`: ten calls and nothing
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
    act: (id, action, version) => ipcRenderer.invoke(LAUNCHER_CHANNELS.act, id, action, version),
    hide: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.hide),
    clearClipboard: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.clearClipboard),
    paste: (text) => ipcRenderer.invoke(LAUNCHER_CHANNELS.paste, text),
    plugins: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.plugins),
    // The name before the rename, for launcher pages from hosts that predate it.
    addons: () => ipcRenderer.invoke(LAUNCHER_CHANNELS.plugins),
    onOpened: (listener) => {
        ipcRenderer.on(LAUNCHER_CHANNELS.opened, (_event, query: unknown) => listener(typeof query === "string" ? query : ""));
    },
    onHidden: (listener) => {
        ipcRenderer.on(LAUNCHER_CHANNELS.hidden, () => listener());
    }
};

contextBridge.exposeInMainWorld("polarisLauncher", bridge);
