/**
 * The bridge the dashboard sees: `window.polarisDesktop`.
 *
 * Runs sandboxed, with context isolation - the page gets these functions and
 * nothing of Node or of Electron. Each one is a single IPC request whose
 * arguments the main process validates again and whose sender it checks is the
 * configured Polaris; this file only shapes the calls.
 */

import { contextBridge, ipcRenderer, webFrame } from "electron";
import { followTitleBarColors } from "@/shared/title-bar";
import { reportTextSize } from "./text-size";
import { holdOutsideLinks } from "./outside-links";
import { readUpdateReady } from "@/shared/update-ready";
import { readUpdateCheck } from "@/shared/update-check";
import type { CallHotkey } from "@/shared/call-hotkeys";
import type { VoiceAction } from "@/shared/voice-widget";
import {
    CHANNELS,
    VERSION_ARGUMENT,
    type ComputerState,
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
    noticeFeatures: process.platform === "darwin" ? ["subtitle", "icon"] : ["icon"],
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
        findUsb: () => ipcRenderer.invoke(CHANNELS.tvFindUsb),
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
    onWindowShown: (listener) => {
        const heard = (_event: unknown, shown: boolean) => listener(shown === true);
        ipcRenderer.on(CHANNELS.windowShown, heard);
        return () => {
            ipcRenderer.removeListener(CHANNELS.windowShown, heard);
        };
    },
    setCallHotkeys: (input) => ipcRenderer.invoke(CHANNELS.callHotkeys, input),
    onCallHotkey: (listener) => {
        const heard = (_event: unknown, which: CallHotkey) => listener(which);
        ipcRenderer.on(CHANNELS.callHotkey, heard);
        return () => {
            ipcRenderer.removeListener(CHANNELS.callHotkey, heard);
        };
    },
    setVoiceState: (state) => ipcRenderer.invoke(CHANNELS.voiceState, state),
    onVoiceAction: (listener) => {
        const heard = (_event: unknown, action: VoiceAction) => listener(action);
        ipcRenderer.on(CHANNELS.voiceAction, heard);
        return () => {
            ipcRenderer.removeListener(CHANNELS.voiceAction, heard);
        };
    },
    openServers: () => ipcRenderer.invoke(CHANNELS.openServers),
    openMailDefaults: () => ipcRenderer.invoke(CHANNELS.openMailDefaults),
    setAppBadge: (input) => ipcRenderer.invoke(CHANNELS.appBadge, input),
    setAppIcon: (input) => ipcRenderer.invoke(CHANNELS.appIcon, input),
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
    keyWrap: {
        seal: (data) => ipcRenderer.invoke(CHANNELS.keyWrapSeal, data),
        open: (sealed) => ipcRenderer.invoke(CHANNELS.keyWrapOpen, sealed)
    },
    vpn: {
        deviceName: () => ipcRenderer.invoke(CHANNELS.vpnDeviceName),
        key: () => ipcRenderer.invoke(CHANNELS.vpnKey),
        up: (input) => ipcRenderer.invoke(CHANNELS.vpnUp, input),
        down: () => ipcRenderer.invoke(CHANNELS.vpnDown),
        status: () => ipcRenderer.invoke(CHANNELS.vpnStatus),
        joinNetwork: (input) => ipcRenderer.invoke(CHANNELS.vpnJoin, input)
    },
    editing: {
        // The checker runs in this process, so a word is answered without a
        // round trip to the main one; a checker that is off says "fine".
        spelling: (word) => {
            if (typeof word !== "string" || word.length === 0 || word.length > 64) return { misspelled: false, suggestions: [] };
            try {
                const misspelled = webFrame.isWordMisspelled(word);
                return { misspelled, suggestions: misspelled ? webFrame.getWordSuggestions(word).slice(0, 5) : [] };
            } catch {
                return { misspelled: false, suggestions: [] };
            }
        },
        addToDictionary: (word) => ipcRenderer.invoke(CHANNELS.editAddWord, word),
        readClipboard: () => ipcRenderer.invoke(CHANNELS.editReadClipboard),
        writeClipboard: (text) => ipcRenderer.invoke(CHANNELS.editWriteClipboard, text),
        copyImageAt: (x, y) => ipcRenderer.invoke(CHANNELS.editCopyImage, x, y),
        saveImage: (url) => ipcRenderer.invoke(CHANNELS.editSaveImage, url)
    },
    computer: {
        state: () => ipcRenderer.invoke(CHANNELS.computerState),
        pair: (code) => ipcRenderer.invoke(CHANNELS.computerPair, code),
        forget: () => ipcRenderer.invoke(CHANNELS.computerForget),
        prepare: () => ipcRenderer.invoke(CHANNELS.computerPrepare),
        folders: () => ipcRenderer.invoke(CHANNELS.computerFolders),
        pickFolder: () => ipcRenderer.invoke(CHANNELS.computerPickFolder),
        removeFolder: (folder) => ipcRenderer.invoke(CHANNELS.computerRemoveFolder, folder),
        onState: (listener) => {
            const heard = (_event: unknown, state: ComputerState) => listener(state);
            ipcRenderer.on(CHANNELS.computerEvent, heard);
            return () => ipcRenderer.removeListener(CHANNELS.computerEvent, heard);
        }
    }
};

contextBridge.exposeInMainWorld("polarisDesktop", bridge);

followTitleBarColors((colors) => void ipcRenderer.invoke(CHANNELS.titleBarColors, colors));
reportTextSize((raw) => void ipcRenderer.invoke(CHANNELS.textSizeSeen, raw));
holdOutsideLinks((url) => ipcRenderer.invoke(CHANNELS.openOutside, url));
