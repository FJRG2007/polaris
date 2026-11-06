/**
 * The bridge the dashboard sees: `window.polarisDesktop`.
 *
 * Runs sandboxed, with context isolation - the page gets these functions and
 * nothing of Node or of Electron. Each one is a single IPC request whose
 * arguments the main process validates again and whose sender it checks is the
 * configured Polaris; this file only shapes the calls.
 */

import { contextBridge, ipcRenderer } from "electron";
import { followTitleBarColors } from "@/shared/title-bar";
import { readUpdateReady } from "@/shared/update-ready";
import { readUpdateCheck } from "@/shared/update-check";
import {
    CHANNELS,
    VERSION_ARGUMENT,
    type GameActivity,
    type NoticeAction,
    type NoticeReply,
    type PolarisDesktop,
    type TvInstallState
} from "@/shared/bridge";

const version = process.argv.find((arg) => arg.startsWith(VERSION_ARGUMENT))?.slice(VERSION_ARGUMENT.length) ?? "";

/** How many of the page's `onUpdateReady` listeners are attached. */
let updateListeners = 0;

const bridge: PolarisDesktop = {
    version,
    platform: process.platform,
    noticeFeatures: ["subtitle", "icon"],
    notify: (input) => ipcRenderer.invoke(CHANNELS.notify, input),
    closeNotice: (tag) => ipcRenderer.invoke(CHANNELS.closeNotice, tag),
    onNoticeReply: (listener) => {
        const heard = (_event: unknown, reply: NoticeReply) => listener(reply);
        ipcRenderer.on(CHANNELS.noticeReply, heard);
        return () => {
            ipcRenderer.removeListener(CHANNELS.noticeReply, heard);
        };
    },
    onNoticeAction: (listener) => {
        const heard = (_event: unknown, action: NoticeAction) => listener(action);
        ipcRenderer.on(CHANNELS.noticeAction, heard);
        return () => {
            ipcRenderer.removeListener(CHANNELS.noticeAction, heard);
        };
    },
    pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
    pushLocal: (input) => ipcRenderer.invoke(CHANNELS.pushLocal, input),
    openWindow: (input) => ipcRenderer.invoke(CHANNELS.openWindow, input),
    gameActivity: () => ipcRenderer.invoke(CHANNELS.gameCurrent),
    onGameActivity: (listener) => {
        const heard = (_event: unknown, game: GameActivity | null) => listener(game);
        ipcRenderer.on(CHANNELS.gameActivity, heard);
        return () => {
            ipcRenderer.removeListener(CHANNELS.gameActivity, heard);
        };
    },
    setCustomGames: (games) => ipcRenderer.invoke(CHANNELS.gameCustom, games),
    runningPrograms: () => ipcRenderer.invoke(CHANNELS.gamePrograms),
    installTool: (input) => ipcRenderer.invoke(CHANNELS.installTool, input),
    openTvInstall: () => ipcRenderer.invoke(CHANNELS.tvOpen),
    tv: {
        state: () => ipcRenderer.invoke(CHANNELS.tvState),
        find: () => ipcRenderer.invoke(CHANNELS.tvFind),
        cancel: () => ipcRenderer.invoke(CHANNELS.tvCancel),
        start: (input) => ipcRenderer.invoke(CHANNELS.tvStart, input),
        onState: (listener) => {
            const heard = (_event: unknown, state: TvInstallState) => listener(state);
            ipcRenderer.on(CHANNELS.tvEvent, heard);
            return () => {
                ipcRenderer.removeListener(CHANNELS.tvEvent, heard);
            };
        }
    },
    defaultBrowser: () => ipcRenderer.invoke(CHANNELS.defaultBrowser),
    systemIdle: () => ipcRenderer.invoke(CHANNELS.systemIdle),
    openServers: () => ipcRenderer.invoke(CHANNELS.openServers),
    setAppBadge: (input) => ipcRenderer.invoke(CHANNELS.appBadge, input),
    shareSources: (input) => ipcRenderer.invoke(CHANNELS.shareSources, input),
    chooseShare: (input) => ipcRenderer.invoke(CHANNELS.chooseShare, input),
    drawOnShare: (stroke) => ipcRenderer.invoke(CHANNELS.drawOnShare, stroke),
    canDrawOnShare: () => ipcRenderer.invoke(CHANNELS.canDrawOnShare),
    stopDrawing: () => ipcRenderer.invoke(CHANNELS.stopDrawing),
    updateReady: async () => readUpdateReady(await ipcRenderer.invoke(CHANNELS.updateCurrent)),
    onUpdateReady: (listener) => {
        const heard = (_event: unknown, update: unknown) => listener(readUpdateReady(update));
        ipcRenderer.on(CHANNELS.updateReady, heard);
        // The first listener says this page draws the button, the last one gone
        // that it stopped - so the app knows whether to announce it itself.
        if (updateListeners++ === 0) void ipcRenderer.invoke(CHANNELS.offerUpdate, true);
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            ipcRenderer.removeListener(CHANNELS.updateReady, heard);
            if (--updateListeners === 0) void ipcRenderer.invoke(CHANNELS.offerUpdate, false);
        };
    },
    installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate),
    checkForUpdates: async () => readUpdateCheck(await ipcRenderer.invoke(CHANNELS.checkUpdates)),
    vpn: {
        deviceName: () => ipcRenderer.invoke(CHANNELS.vpnDeviceName),
        key: () => ipcRenderer.invoke(CHANNELS.vpnKey),
        up: (input) => ipcRenderer.invoke(CHANNELS.vpnUp, input),
        down: () => ipcRenderer.invoke(CHANNELS.vpnDown),
        status: () => ipcRenderer.invoke(CHANNELS.vpnStatus),
        joinNetwork: (input) => ipcRenderer.invoke(CHANNELS.vpnJoin, input)
    }
};

contextBridge.exposeInMainWorld("polarisDesktop", bridge);

followTitleBarColors((colors) => void ipcRenderer.invoke(CHANNELS.titleBarColors, colors));
