/**
 * The bridge the dashboard sees: `window.polarisDesktop`.
 *
 * Runs sandboxed, with context isolation - the page gets these functions and
 * nothing of Node or of Electron. Each one is a single IPC request whose
 * arguments the main process validates again and whose sender it checks is the
 * configured Polaris; this file only shapes the calls.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, VERSION_ARGUMENT, type PolarisDesktop } from "@/shared/bridge";

const version =
    process.argv.find((arg) => arg.startsWith(VERSION_ARGUMENT))?.slice(VERSION_ARGUMENT.length) ??
    "";

const bridge: PolarisDesktop = {
    version,
    platform: process.platform,
    notify: (input) => ipcRenderer.invoke(CHANNELS.notify, input),
    closeNotice: (tag) => ipcRenderer.invoke(CHANNELS.closeNotice, tag),
    pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
    pushLocal: (input) => ipcRenderer.invoke(CHANNELS.pushLocal, input),
    openWindow: (input) => ipcRenderer.invoke(CHANNELS.openWindow, input)
};

contextBridge.exposeInMainWorld("polarisDesktop", bridge);
