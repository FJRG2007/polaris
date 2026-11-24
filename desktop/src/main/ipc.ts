/**
 * Every request a page can make of the main process, checked at the door.
 *
 * A channel answers only the kind of window it was made for, and the
 * dashboard's channels answer only the main frame of a window that is on the
 * configured Polaris at the moment of the call. Every argument is parsed with a
 * schema before it is used: the dashboard is trusted to be the dashboard, not to
 * be free of a bug that lets somebody else's text reach this bridge.
 */

import { registerAddonIpc } from "./addons/electron";
import { z } from "zod";
import { readHostPath, type HostPageOutcome, type LocalSettingsState } from "@/shared/settings-route";
import { overlayHeight, titleBarColorsSchema } from "@/shared/title-bar";
import { runningPrograms } from "./game-detect";
import { chooseShare, endShare, listShareSources, SOURCE_ID } from "./screen-share";
import { canDrawOnShare, drawOnShare, stopDrawing } from "./annotate-overlay";
import { strokeSchema } from "@/shared/annotate";
import { setCallHotkeys } from "./call-hotkeys";
import { followTextSize as followWidgetTextSize, followVoiceWidgetLook, setVoiceState, setVoiceWidgetClickable, voiceWidgetAction } from "./voice-widget";
import { launcherBinding, rememberLauncherClipboardKeep, rememberLauncherEngine, rememberTextSize, rememberVoiceWidgetLook, resetVoiceWidgetLayout, textSize, voiceWidgetLook } from "./settings";
import { readTextSize } from "@/shared/text-size";
import { lookChangeSchema, voiceActionSchema, voiceStateSchema, withLookChange } from "@/shared/voice-widget";
import { callHotkeysSchema, type CallHotkeysResult } from "@/shared/call-hotkeys";
import { closeNotice, showNotice } from "./notices";
import { appBadgeSchema, applyAppBadge } from "./app-badge";
import { appIconSchema, reportAppIcon } from "./app-icon";
import { isSafeExternalUrl, isServerUrl, serverPath } from "./navigation";
import { openExternal } from "./open-external";
import { clipboardText, dictionaryWord, pagePoint, savableImageUrl } from "./context-menu";
import { FolderRefusal, zipFolder } from "./folder-zip";
import { cancelApiKey, keyFormState, submitApiKey } from "./key-flow";
import { kindOf, openPolarisWindow, type WindowKind } from "./windows";
import { installTool } from "./install-tool";
import { runner } from "./runner";
import * as vpn from "./vpn";
import { openKey, sealKey } from "./key-wrap";
import { checkPageFiles, pageChanged } from "./integrity";
import { openTvInstall, registerTvInstall } from "./tv-install";
import { browserFromName, installRequestSchema, type InstallResult } from "@/shared/install-tools";
import {
    type AddressCheck,
    CHANNELS,
    type ComputerFolderPick,
    type ComputerPairOutcome,
    type CustomGameInput,
    type GameActivity,
    type Outcome,
    type PickedFolder,
    type HostImport,
    type HostsSnapshot,
    type HostStatus,
    type Preferences,
    type SettingsFeature,
    type PreferenceToggle,
    type SystemIdle
} from "@/shared/bridge";
import { readCallNote, type Relaunch } from "@/shared/relaunch";
import type { ServerRow } from "@/shared/servers";
import type { UpdateReadyState } from "./update-ready";
import type { UpdateCheck } from "@/shared/update-check";
import { readServerAddress } from "@/shared/server-address";
import { openPush, pushOf, pushTargetSchema, type PushHost } from "./push-local";
import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    nativeImage,
    powerMonitor,
    safeStorage,
    shell,
    type IpcMainInvokeEvent,
    type NativeImage,
    type WebContents,
    webContents
} from "electron";
import { ICON_ACCEPT, iconAcceptable } from "./notice-layout";
import { clearClipboardHistory, followClipboardKeep, launcherStatus, recordLauncherKey, setLauncherBinding } from "./launcher";
import { appKeyPressSchema, readAppSettingChange, type AppSettingChange } from "@polaris/core/app-settings";
import { bindingFromPress } from "@/shared/launcher-hotkey";

export interface IpcHost extends PushHost {
    /** The game running now, as the watcher last saw it. */
    readonly runningGame: () => GameActivity | null;
    /** Whether this page is the main window's, which is the one that reports. */
    readonly isReporter: (sender: WebContents) => boolean;
    readonly setCustomGames: (games: readonly CustomGameInput[]) => void;
    /** The address form's state: the address in use and why it failed to open. */
    readonly preferences: () => Preferences;
    readonly setOpenAtLogin: (open: boolean) => Promise<boolean>;
    /** Keep whether the graphics card is used from the next start. */
    readonly setHardwareAcceleration: (on: boolean) => boolean;
    readonly setToggle: (name: PreferenceToggle, on: boolean) => boolean;
    /** Close and open the app again, unless something running would be lost. */
    readonly relaunch: () => Outcome;
    readonly connectState: () => { address: string | null; error: string | null; servers: ServerRow[]; settings: LocalSettingsState; };
    /** Open the host's update page in the Polaris window; "offline" with none to open it in. */
    readonly openOnHost: (path: string) => Promise<HostPageOutcome>;
    readonly connectSubmit: (raw: unknown, name?: string) => Promise<Outcome>;
    readonly connectCheck: (raw: unknown) => Promise<AddressCheck>;
    readonly switchServer: (origin: string) => Promise<Outcome>;
    /** Give a listed host another address and name; a new address is checked first. */
    readonly editServer: (origin: string, address: string, name: string) => Promise<Outcome>;
    readonly removeServer: (origin: string) => Outcome;
    /** Keep a host from Settings > This app > Hosts, checked first, without opening it. */
    readonly addServer: (raw: unknown, name: string) => Promise<Outcome>;
    /** Whether a listed host answers as a Polaris now. */
    readonly hostStatus: (origin: string) => Promise<HostStatus>;
    /** Moving the list of hosts to and from another device. */
    readonly hosts: {
        readonly link: () => string;
        readonly copy: () => { ok: boolean; count: number };
        readonly exportFile: (parent: BrowserWindow | null) => Promise<HostImport>;
        readonly importFile: (parent: BrowserWindow | null) => Promise<HostImport>;
        readonly take: (text: string) => HostImport;
    };
    /** Put the settings away, from the page itself. */
    readonly closeConnect: () => void;
    /** Manage the hosts, asked by a Polaris page: its own Hosts when it draws them,
     *  else the hosts window saying the host is older than this app. */
    readonly manageHosts: (sender: WebContents) => void;
    /** The update waiting for a restart, and the restart into it. */
    readonly updates: Pick<UpdateReadyState, "current" | "install" | "offer">;
    /** Why this run began, for a page of this origin, with its call once. */
    readonly relaunched: (origin: string) => Relaunch;
    /** A page is on this call now (its own note of it), or on none. */
    readonly holdCall: (sender: number, origin: string, note: string | null) => void;
    /** Ask for a newer version now, from a press. */
    readonly checkUpdates: () => Promise<UpdateCheck>;
    /** This page draws the app's settings: the tray and the menus open them there.
     *  `hosts` when it manages the hosts too. */
    readonly settingsAnnounced: (sender: WebContents, hosts: boolean) => void;
}

/** A server named by the list: an address in the one stored form. */
const listedSchema = z.unknown().transform(readServerAddress).pipe(z.string());
/** An address to open, and the name to list it under. A bare string is what a
 *  page from before names were asked for sends. */
const submitSchema = z.union([z.string(), z.object({ address: z.string(), name: z.string().max(200).default("") })]);

const noticeSchema = z.object({
    title: z.string().trim().min(1).max(200),
    subtitle: z.string().trim().max(200).optional(),
    body: z.string().max(1000).optional(),
    icon: z.string().max(2048).optional(),
    tag: z.string().min(1).max(200),
    href: z.string().max(2048).optional(),
    insistent: z.boolean().optional(),
    sound: z.boolean().optional(),
    reply: z.object({ placeholder: z.string().trim().min(1).max(120) }).optional(),
    actions: z
        .array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(40) }))
        .max(2)
        .optional()
});

/** How long a notice waits for its picture before it is drawn with the app's. */
const ICON_WAIT_MS = 3_000;

/** Smaller than this is a placeholder, not a face. */
const ICON_MIN_PX = 16;

/**
 * The picture a page named for its notice, read with the page's own session so
 * an avatar behind sign-in is readable. Only a path on the Polaris, only a PNG
 * or JPEG of avatar size; anything else is no picture, never a failed notice.
 */
async function noticeIcon(contents: WebContents, path: string | undefined, origin: string | null): Promise<NativeImage | null> {
    const url = path && origin ? serverPath(path, origin) : null;
    if (!url) return null;
    try {
        const answer = await contents.session.fetch(url, {
            signal: AbortSignal.timeout(ICON_WAIT_MS),
            cache: "force-cache",
            headers: { Accept: ICON_ACCEPT }
        });
        if (!answer.ok) return null;
        const bytes = Buffer.from(await answer.arrayBuffer());
        if (!iconAcceptable(answer.headers.get("content-type"), bytes.length)) return null;
        const image = nativeImage.createFromBuffer(bytes);
        // A person with no picture is answered a transparent pixel, which the
        // page draws initials over; on a notice it is a blank tile.
        return image.isEmpty() || image.getSize().width < ICON_MIN_PX ? null : image;
    } catch {
        return null;
    }
}

/** A control character: the dashboard refuses a name with one, so a report
 *  carrying it would be dropped. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A control character, or a character a path is built from. */
const UNPRINTABLE = /[\u0000-\u001f\u007f/\\]/;

/** The programs a page may say are games. The same limits the dashboard keeps,
 *  so a page cannot hand this more than it would ever store. */
const customGamesSchema = z
    .array(
        z.object({
            executable: z.string().trim().min(1).max(120).refine((value) => !UNPRINTABLE.test(value)),
            name: z
                .string()
                .trim()
                .min(1)
                .max(100)
                .refine((value) => !CONTROL.test(value))
        })
    )
    .max(100);

const connectionSchema = z.object({
    nodeId: z.string().uuid(),
    address: z.string().min(1).max(64),
    dns: z.array(z.string().min(1).max(64)).max(4),
    nodePublicKey: z.string().min(1).max(64),
    endpoint: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    own: z
        .object({
            privateKey: z.string().min(1).max(64),
            presharedKey: z.string().min(1).max(64).nullable(),
            moreAddresses: z.array(z.string().min(1).max(64)).max(3),
            allowedIps: z.array(z.string().min(1).max(64)).min(1).max(64),
            mtu: z.number().int().min(576).max(9000).nullable()
        })
        .optional()
});

const windowSchema = z.object({
    path: z.string().min(1).max(2048),
    title: z.string().trim().min(1).max(200)
});

/** How long untouched before this computer counts as nobody being at it. */
const IDLE_AFTER_SECONDS = 120;

const REFUSAL = "This window may not do that.";
const REFUSED: Outcome = { ok: false, error: REFUSAL };

/** Windows opened for one path, so asking twice brings the first forward. */
const opened = new Map<string, BrowserWindow>();

export function registerIpc(host: IpcHost): void {
    /** The dashboard's channels: a Polaris window's main frame, on the Polaris. */
    const fromPolaris = (event: IpcMainInvokeEvent): boolean => {
        const origin = host.server();
        const frame = event.senderFrame;
        return Boolean(
            origin &&
                kindOf(event.sender) === "polaris" &&
                frame &&
                frame === event.sender.mainFrame &&
                isServerUrl(frame.url, origin)
        );
    };
    const from = (event: IpcMainInvokeEvent, kind: WindowKind): boolean => kindOf(event.sender) === kind;
    registerAddonIpc(fromPolaris, (path) => host.showPolaris(path));

    ipcMain.handle(CHANNELS.notify, async (event, raw: unknown): Promise<boolean> => {
        if (!fromPolaris(event)) return false;
        const input = noticeSchema.safeParse(raw);
        if (!input.success) return false;
        const window = BrowserWindow.fromWebContents(event.sender);
        const { href } = input.data;
        const icon = await noticeIcon(event.sender, input.data.icon, host.server());
        if (event.sender.isDestroyed()) return false;
        return showNotice({
            title: input.data.title,
            subtitle: input.data.subtitle,
            body: input.data.body,
            icon,
            tag: input.data.tag,
            insistent: input.data.insistent,
            // The page plays its own sound for what it announces - except where
            // it has said it cannot, which is a call: the window it would ring
            // in is behind whatever somebody is actually doing, and a browser
            // may have suspended its audio. Then the notice rings instead.
            silent: !(input.data.sound ?? false),
            // An alert from the dashboard's feed - a finished deploy - may already
            // have been announced by the push window that started it.
            once: input.data.tag.startsWith("notification:"),
            // Handed back to the page that raised the notice, which is the one
            // that knows where the answer goes.
            ...(input.data.reply
                ? {
                      reply: {
                          placeholder: input.data.reply.placeholder,
                          onReply: (text: string) => {
                              if (!event.sender.isDestroyed()) {
                                  event.sender.send(CHANNELS.noticeReply, { tag: input.data.tag, text });
                              }
                          }
                      }
                  }
                : {}),
            ...(input.data.actions?.length
                ? {
                      actions: input.data.actions,
                      onAction: (action: string) => {
                          if (!event.sender.isDestroyed()) {
                              event.sender.send(CHANNELS.noticeAction, { tag: input.data.tag, action });
                          }
                      }
                  }
                : {}),
            onClick: () => {
                const origin = host.server();
                const url = href && origin ? serverPath(href, origin) : null;
                if (window && !window.isDestroyed()) {
                    if (window.isMinimized()) window.restore();
                    window.show();
                    window.focus();
                    if (url) void window.loadURL(url);
                } else {
                    host.showPolaris(href);
                }
            }
        });
    });

    ipcMain.handle(CHANNELS.closeNotice, (event, tag: unknown) => {
        if (fromPolaris(event) && typeof tag === "string" && tag.length <= 200) closeNotice(tag);
    });

    ipcMain.handle(CHANNELS.pickFolder, async (event): Promise<PickedFolder> => {
        if (!fromPolaris(event)) return { ok: false, error: REFUSAL };
        const window = BrowserWindow.fromWebContents(event.sender);
        const picked = window
            ? await dialog.showOpenDialog(window, { title: "Choose the folder to upload", properties: ["openDirectory"] })
            : await dialog.showOpenDialog({ title: "Choose the folder to upload", properties: ["openDirectory"] });
        const folder = picked.canceled ? undefined : picked.filePaths[0];
        if (!folder) return null;
        try {
            const zipped = await zipFolder(folder);
            return { ok: true, ...zipped };
        } catch (caught) {
            if (caught instanceof FolderRefusal) return { ok: false, error: caught.message };
            console.error("[folder]", caught);
            return { ok: false, error: "Could not read that folder. Check that this app may open it." };
        }
    });

    ipcMain.handle(CHANNELS.pushLocal, (event, raw: unknown): Outcome => {
        if (!fromPolaris(event)) return REFUSED;
        const target = pushTargetSchema.safeParse(raw);
        if (!target.success) return { ok: false, error: "That service could not be read." };
        openPush(target.data, host);
        return { ok: true };
    });

    ipcMain.handle(CHANNELS.openWindow, (event, raw: unknown): Outcome => {
        if (!fromPolaris(event)) return REFUSED;
        const input = windowSchema.safeParse(raw);
        const origin = host.server();
        const url = input.success && origin ? serverPath(input.data.path, origin) : null;
        if (!input.success || !url) return { ok: false, error: "That is not a page of this Polaris." };
        const open = opened.get(url);
        if (open && !open.isDestroyed()) {
            open.show();
            open.focus();
            return { ok: true };
        }
        const window = openPolarisWindow(url, host.server, { title: input.data.title, width: 1100, height: 720 });
        opened.set(url, window);
        window.on("closed", () => opened.delete(url));
        return { ok: true };
    });

    // The account's text size, seen in the Polaris window and kept, so the app's
    // own windows read at it - including those opened signed out or offline.
    ipcMain.handle(CHANNELS.textSizeSeen, (event, raw: unknown): boolean => {
        const size = readTextSize(raw);
        if (!fromPolaris(event) || size === null) return false;
        if (!rememberTextSize(size)) return true;
        for (const contents of webContents.getAllWebContents()) {
            const kind = kindOf(contents);
            if (kind && kind !== "polaris" && !contents.isDestroyed()) contents.send(CHANNELS.textSizeChanged, size);
        }
        followWidgetTextSize();
        return true;
    });
    // Asked by every page of the app's own as it loads, after the size it was
    // opened with (`TEXT_SIZE_ARGUMENT`) is already drawn; the size is no secret.
    ipcMain.handle(CHANNELS.textSize, (): number => textSize());

    // The window that asked is the one whose taskbar button carries it.
    ipcMain.handle(CHANNELS.appBadge, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const badge = appBadgeSchema.safeParse(raw);
        if (!badge.success) return false;
        applyAppBadge(BrowserWindow.fromWebContents(event.sender), badge.data);
        return true;
    });

    // The season's icon, settled across every window's host (see app-icon).
    ipcMain.handle(CHANNELS.appIcon, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const icon = appIconSchema.safeParse(raw);
        if (!icon.success) return false;
        const origin = URL.parse(event.senderFrame?.url ?? "")?.origin;
        if (!origin) return false;
        reportAppIcon(origin, icon.data);
        return true;
    });

    // Whether anybody is at this computer. The threshold is fixed here rather
    // than asked for, so the page cannot turn it into a probe of how long the
    // machine has sat untouched. `unknown` where the system cannot say (some
    // Linux sessions), which the dashboard reads as somebody being here.
    ipcMain.handle(CHANNELS.systemIdle, (event): SystemIdle => {
        if (!fromPolaris(event)) return "unknown";
        try {
            return powerMonitor.getSystemIdleState(IDLE_AFTER_SECONDS);
        } catch {
            return "unknown";
        }
    });

    // The chat account key's device lock, sealed by the operating system's
    // key store and bound to the server asking (see key-wrap).
    // Refused to a page the code check found changed (integrity.ts): the key
    // it would unwrap is the one a changed page is after.
    ipcMain.handle(CHANNELS.keyWrapSeal, (event, data: unknown): string | null => {
        if (!fromPolaris(event) || pageChanged(event.sender)) return null;
        return sealKey(safeStorage, event.senderFrame?.url, data);
    });
    ipcMain.handle(CHANNELS.keyWrapOpen, (event, sealed: unknown): string | null => {
        if (!fromPolaris(event) || pageChanged(event.sender)) return null;
        return openKey(safeStorage, event.senderFrame?.url, sealed);
    });
    // The page code check (docs/integrity.md): the files the preload hashed, for
    // the configured Polaris only, so no other page can make this fetch anything.
    ipcMain.handle(CHANNELS.integrityCheck, async (event, files: unknown) => {
        const page = event.senderFrame?.url;
        if (!fromPolaris(event) || !page) return null;
        return checkPageFiles(event.sender, new URL(page).origin, files).catch(() => null);
    });

    // The call's keys, held system-wide while a call is on. A shape that does
    // not parse lets go of whatever this window held rather than keeping it.
    ipcMain.handle(CHANNELS.callHotkeys, (event, raw: unknown): CallHotkeysResult => {
        if (!fromPolaris(event)) return { mic: false, deafen: false };
        const input = callHotkeysSchema.safeParse(raw);
        return setCallHotkeys(event.sender, input.success ? input.data : null);
    });

    // Who is in the call, for the voice widget. A shape that does not parse
    // ends what this page had shown rather than keeping it.
    ipcMain.handle(CHANNELS.voiceState, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const input = voiceStateSchema.safeParse(raw);
        setVoiceState(event.sender, input.success ? input.data : null);
        return input.success;
    });
    // A press on the widget, for the page in the call.
    ipcMain.handle(CHANNELS.widgetAction, (event, raw: unknown): boolean => {
        const action = voiceActionSchema.safeParse(raw);
        return from(event, "voice-widget") && action.success && voiceWidgetAction(action.data);
    });
    // The widget's pointer over (true) or off (false) a region that takes clicks while locked.
    ipcMain.handle(CHANNELS.widgetClickable, (event, raw: unknown): void => {
        const on = z.boolean().safeParse(raw);
        if (from(event, "voice-widget") && on.success) setVoiceWidgetClickable(on.data);
    });

    ipcMain.handle(CHANNELS.gameCurrent, (event) => {
        if (!fromPolaris(event)) return { game: null, reporter: false };
        return { game: host.runningGame(), reporter: host.isReporter(event.sender) };
    });

    ipcMain.handle(CHANNELS.gameCustom, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const games = customGamesSchema.safeParse(raw);
        if (!games.success) return false;
        host.setCustomGames(games.data);
        return true;
    });

    // The names only, deduplicated and sorted, and only to the page that asked:
    // somebody pressed "choose from what is running" to add a game.
    ipcMain.handle(CHANNELS.gamePrograms, async (event): Promise<string[]> => {
        if (!fromPolaris(event)) return [];
        const names = await runningPrograms().catch(() => [] as string[]);
        return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
    });

    ipcMain.handle(CHANNELS.shareSources, async (event, raw: unknown) => {
        if (!fromPolaris(event)) return null;
        const input = z
            .object({ thumbnails: z.boolean().optional(), kind: z.enum(["screen", "window"]).optional() })
            .optional()
            .safeParse(raw);
        return listShareSources(input.success ? input.data : undefined).catch((caught: unknown) => {
            console.error("[screen-share]", caught);
            return null;
        });
    });

    ipcMain.handle(CHANNELS.chooseShare, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const input = z.object({ id: z.string().max(200).regex(SOURCE_ID), sound: z.boolean() }).safeParse(raw);
        if (!input.success) return false;
        chooseShare(input.data.id, input.data.sound);
        return true;
    });

    ipcMain.handle(CHANNELS.drawOnShare, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const stroke = strokeSchema.safeParse(raw);
        return stroke.success ? drawOnShare(stroke.data) : false;
    });

    ipcMain.handle(CHANNELS.canDrawOnShare, (event): boolean => fromPolaris(event) && canDrawOnShare());

    ipcMain.handle(CHANNELS.stopDrawing, (event): void => {
        if (!fromPolaris(event)) return;
        stopDrawing();
        endShare();
    });

    // Takes a name from a list and nothing else; see `install-tools`.
    registerTvInstall((event) => kindOf(event.sender) === "tv" || fromPolaris(event));
    ipcMain.handle(CHANNELS.tvOpen, (event): boolean => {
        if (!fromPolaris(event)) return false;
        openTvInstall();
        return true;
    });

    ipcMain.handle(CHANNELS.computerState, (event) => (fromPolaris(event) ? runner().snapshot() : null));
    ipcMain.handle(CHANNELS.computerPair, async (event, raw: unknown): Promise<ComputerPairOutcome> => {
        const code = z.string().trim().min(4).max(20).safeParse(raw);
        if (!fromPolaris(event) || !code.success) return { ok: false, reason: "refused" };
        return runner().pair(code.data);
    });
    ipcMain.handle(CHANNELS.computerForget, async (event) => {
        if (!fromPolaris(event)) return false;
        await runner().forget();
        return true;
    });
    ipcMain.handle(CHANNELS.computerPrepare, (event) => (fromPolaris(event) ? runner().prepareNow() : false));
    ipcMain.handle(CHANNELS.computerFolders, (event) => (fromPolaris(event) ? runner().folders() : []));
    // The same native folder dialog the upload picker opens, keeping the path
    // instead of zipping it.
    ipcMain.handle(CHANNELS.computerPickFolder, async (event): Promise<ComputerFolderPick> => {
        if (!fromPolaris(event)) return { ok: false, reason: "refused" };
        const window = BrowserWindow.fromWebContents(event.sender);
        const options = { title: "Choose a folder for sessions on this computer", properties: ["openDirectory" as const] };
        const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        const folder = picked.canceled ? undefined : picked.filePaths[0];
        if (!folder) return null;
        const saved = await runner().addFolder(folder);
        return saved ? { ok: true, folder, folders: [...saved] } : { ok: false, reason: "storage" };
    });
    ipcMain.handle(CHANNELS.computerRemoveFolder, async (event, raw: unknown) => {
        const folder = z.string().min(1).max(1000).safeParse(raw);
        if (!fromPolaris(event) || !folder.success) return null;
        const saved = await runner().removeFolder(folder.data);
        return saved ? [...saved] : null;
    });
    runner().listen((state) => {
        for (const window of BrowserWindow.getAllWindows())
            if (!window.isDestroyed() && kindOf(window.webContents) === "polaris") window.webContents.send(CHANNELS.computerEvent, state);
    });

    ipcMain.handle(CHANNELS.installTool, async (event, raw: unknown): Promise<InstallResult> => {
        const request = installRequestSchema.safeParse(raw);
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!fromPolaris(event) || !request.success || !window) return { ok: false, reason: "refused" };
        return installTool(window, request.data);
    });

    // A plain click on a link to another site, taken by the preload before the
    // page starts to leave (`preload/outside-links`). Refused for anything but
    // the Polaris itself, and the preload then follows the link as before.
    ipcMain.handle(CHANNELS.openOutside, (event, raw: unknown): boolean => {
        if (!fromPolaris(event) || typeof raw !== "string" || !isSafeExternalUrl(raw)) return false;
        openExternal(raw);
        return true;
    });

    // Polaris's own right-click menu (`EditingBridge`): the dictionary, the
    // clipboard and the picture under the pointer. The clipboard is read only
    // while the window has focus, as the browser's own clipboard API is.
    ipcMain.handle(CHANNELS.editAddWord, (event, raw: unknown): boolean => {
        const word = dictionaryWord(raw);
        if (!fromPolaris(event) || !word) return false;
        return event.sender.session.addWordToSpellCheckerDictionary(word);
    });
    ipcMain.handle(CHANNELS.editReadClipboard, async (event): Promise<string | null> => {
        if (!fromPolaris(event) || !BrowserWindow.fromWebContents(event.sender)?.isFocused()) return null;
        return await clipboard.readText();
    });
    ipcMain.handle(CHANNELS.editWriteClipboard, async (event, raw: unknown): Promise<boolean> => {
        const text = clipboardText(raw);
        if (!fromPolaris(event) || text === null) return false;
        await clipboard.writeText(text);
        return true;
    });
    ipcMain.handle(CHANNELS.editCopyImage, (event, x: unknown, y: unknown): boolean => {
        const point = fromPolaris(event) ? pagePoint(x, y, event.sender.getZoomFactor()) : null;
        if (!point) return false;
        event.sender.copyImageAt(point.x, point.y);
        return true;
    });
    ipcMain.handle(CHANNELS.editSaveImage, (event, raw: unknown): boolean => {
        const url = savableImageUrl(raw);
        if (!fromPolaris(event) || !url) return false;
        event.sender.downloadURL(url);
        return true;
    });

    ipcMain.handle(CHANNELS.defaultBrowser, (event): string | null => {
        if (!fromPolaris(event)) return null;
        const name = app.getApplicationNameForProtocol("https://");
        if (/firefox/i.test(name)) return "firefox";
        return browserFromName(name);
    });

    ipcMain.handle(CHANNELS.openServers, (event): void => {
        if (fromPolaris(event)) host.manageHosts(event.sender);
    });

    // The page cannot open an ms-settings: link itself: navigation sends only
    // http, https and mailto out of the app.
    ipcMain.handle(CHANNELS.openMailDefaults, async (event): Promise<boolean> => {
        if (!fromPolaris(event) || process.platform !== "win32") return false;
        try {
            await shell.openExternal("ms-settings:defaultapps?registeredAppUser=Polaris");
            return true;
        } catch {
            return false;
        }
    });

    // The window buttons drawn over the page's header, in its colours.
    ipcMain.handle(CHANNELS.titleBarColors, (event, raw: unknown): void => {
        if (!fromPolaris(event) || process.platform === "darwin") return;
        const colors = titleBarColorsSchema.safeParse(raw);
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!colors.success || !window) return;
        window.setTitleBarOverlay({
            color: colors.data.background,
            symbolColor: colors.data.symbol,
            height: overlayHeight(event.sender.getZoomFactor())
        });
    });

    ipcMain.handle(CHANNELS.checkUpdates, (event, ...args: unknown[]) => {
        if (!fromPolaris(event) || !z.tuple([]).safeParse(args).success) return null;
        return host.checkUpdates();
    });

    ipcMain.handle(CHANNELS.updateCurrent, (event) => (fromPolaris(event) ? host.updates.current() : null));

    // Takes nothing, and answers once per run: the first Polaris page to ask
    // after a restart the app made is the one that carries the call across it.
    ipcMain.handle(CHANNELS.relaunched, (event, ...args: unknown[]) => {
        if (!fromPolaris(event) || !z.tuple([]).safeParse(args).success) return null;
        return host.relaunched(new URL(event.senderFrame!.url).origin);
    });

    // The page's own note of the call it is on, kept only to be handed back to
    // it after a restart the app makes. Forgotten with the page.
    const holding = new Set<number>();
    ipcMain.handle(CHANNELS.holdCall, (event, ...args: unknown[]): boolean => {
        if (!fromPolaris(event) || args.length !== 1) return false;
        const note = readCallNote(args[0]);
        if (note === undefined) return false;
        const sender = event.sender;
        host.holdCall(sender.id, new URL(event.senderFrame!.url).origin, note);
        if (!holding.has(sender.id)) {
            holding.add(sender.id);
            sender.once("destroyed", () => {
                holding.delete(sender.id);
                host.holdCall(sender.id, "", null);
            });
            // Another page in the same window is not on this call; one that
            // is says so again as it comes back into it.
            sender.on("did-start-navigation", (details: { isMainFrame?: boolean; isSameDocument?: boolean; }) => {
                if (details?.isMainFrame && !details.isSameDocument) host.holdCall(sender.id, "", null);
            });
        }
        return true;
    });

    // Takes nothing: what is installed is what the app downloaded and checked
    // itself, never anything the page names.
    ipcMain.handle(CHANNELS.installUpdate, (event, ...args: unknown[]): Outcome => {
        if (!fromPolaris(event) || !z.tuple([]).safeParse(args).success) return REFUSED;
        return host.updates.install();
    });

    ipcMain.handle(CHANNELS.vpnDeviceName, (event): string | null =>
        fromPolaris(event) ? vpn.vpnDeviceName() : null
    );
    ipcMain.handle(CHANNELS.vpnKey, (event): Promise<string | null> | null =>
        fromPolaris(event) ? vpn.vpnKey() : null
    );
    ipcMain.handle(CHANNELS.vpnUp, (event, raw: unknown): Promise<Outcome> | Outcome => {
        const input = connectionSchema.safeParse(raw);
        if (!fromPolaris(event) || !input.success) return REFUSED;
        return vpn.vpnUp(input.data);
    });
    ipcMain.handle(CHANNELS.vpnDown, (event): Promise<Outcome> | Outcome =>
        fromPolaris(event) ? vpn.vpnDown() : REFUSED
    );
    ipcMain.handle(CHANNELS.vpnStatus, (event) =>
        fromPolaris(event) ? vpn.vpnStatus() : { nodeId: null }
    );
    ipcMain.handle(CHANNELS.vpnJoin, (event, raw: unknown): Promise<Outcome> | Outcome =>
        fromPolaris(event) ? vpn.vpnJoinNetwork(raw) : REFUSED
    );

    // A page saying it draws the restart button. Forgotten with the page: a
    // reload or another site in the window is a page that has not said it.
    const watched = new Set<number>();
    ipcMain.handle(CHANNELS.offerUpdate, (event, raw: unknown): void => {
        const on = z.boolean().safeParse(raw);
        if (!fromPolaris(event) || !on.success) return;
        const sender = event.sender;
        host.updates.offer(sender.id, on.data);
        if (watched.has(sender.id)) return;
        watched.add(sender.id);
        const forget = () => host.updates.offer(sender.id, false);
        sender.on("did-start-navigation", (details: { isMainFrame?: boolean; isSameDocument?: boolean; }) => {
            if (details.isMainFrame && !details.isSameDocument) forget();
        });
        sender.once("destroyed", () => {
            forget();
            watched.delete(sender.id);
        });
    });

    ipcMain.handle(CHANNELS.connectState, (event) => (from(event, "connect") ? host.connectState() : null));
    ipcMain.handle(CHANNELS.connectSubmit, (event, raw: unknown) => {
        const input = submitSchema.safeParse(raw);
        if (!from(event, "connect") || !input.success) return REFUSED;
        return typeof input.data === "string"
            ? host.connectSubmit(input.data)
            : host.connectSubmit(input.data.address, input.data.name);
    });
    ipcMain.handle(CHANNELS.connectCheck, (event, raw: unknown) =>
        from(event, "connect") ? host.connectCheck(raw) : { ok: false, message: null }
    );
    ipcMain.handle(CHANNELS.connectSwitch, (event, raw: unknown) => {
        const origin = listedSchema.safeParse(raw);
        return from(event, "connect") && origin.success ? host.switchServer(origin.data) : REFUSED;
    });
    // The app's settings, for the host's own Settings page ("This app"). The
    // values are this computer's, so the page only reads and changes them
    // through these calls, each validated here. The list of hosts decides which
    // server this app trusts, so every address the page hands over goes through
    // the same schema and the same probe as one typed in the hosts window, and
    // only the Polaris main frame on the host in use may ask.
    const changed = (): void => {
        for (const contents of webContents.getAllWebContents()) {
            const kind = kindOf(contents);
            if (kind === "polaris") contents.send(CHANNELS.appSettingsChanged);
        }
    };
    const snapshot = async () => {
        const status = await launcherStatus();
        const state = host.connectState();
        const look = voiceWidgetLook();
        return {
            ...host.preferences(),
            voiceWidgetAvatars: look.avatars,
            voiceWidgetNames: look.names,
            voiceWidgetPeople: look.people,
            voiceWidgetOpacity: String(look.opacity),
            voiceWidgetCorner: look.corner,
            voiceWidgetMaxUsers: look.maxUsers,
            launcherBinding: launcherBinding(),
            launcherKey: status.key,
            launcherProblem: status.problem,
            server: state.address,
            servers: state.servers.map((server) => ({ origin: server.origin, name: server.name }))
        };
    };
    // One look choice, held to the widget's own rule before it is kept.
    const changeLook = (raw: unknown): boolean => {
        const look = lookChangeSchema.safeParse(raw);
        if (!look.success) return false;
        rememberVoiceWidgetLook(withLookChange(voiceWidgetLook(), look.data));
        followVoiceWidgetLook();
        return true;
    };
    const applyChange = async (change: AppSettingChange): Promise<boolean> => {
        switch (change.key) {
            case "openAtLogin":
                return host.setOpenAtLogin(change.value);
            case "hardwareAcceleration":
                return host.setHardwareAcceleration(change.value);
            case "launcherEngine":
                rememberLauncherEngine(change.value);
                return true;
            case "launcherClipboardKeep":
                rememberLauncherClipboardKeep(change.value);
                followClipboardKeep();
                return true;
            case "voiceWidgetAvatars":
                return changeLook({ key: "avatars", value: change.value });
            case "voiceWidgetNames":
                return changeLook({ key: "names", value: change.value });
            case "voiceWidgetPeople":
                return changeLook({ key: "people", value: change.value });
            case "voiceWidgetOpacity":
                return changeLook({ key: "opacity", value: Number(change.value) });
            case "voiceWidgetCorner":
                return changeLook({ key: "corner", value: change.value });
            case "voiceWidgetMaxUsers":
                return changeLook({ key: "maxUsers", value: change.value });
            default:
                return host.setToggle(change.key, change.value);
        }
    };
    ipcMain.handle(CHANNELS.appSettingsGet, (event) => (fromPolaris(event) ? snapshot() : null));
    ipcMain.handle(CHANNELS.appSettingsSet, async (event, raw: unknown) => {
        const change = readAppSettingChange(raw);
        if (!fromPolaris(event) || !change || !(await applyChange(change))) return null;
        changed();
        return snapshot();
    });
    ipcMain.handle(CHANNELS.appSettingsRecord, (event, raw: unknown) => {
        const recording = z.boolean().safeParse(raw);
        if (fromPolaris(event) && recording.success) recordLauncherKey(recording.data);
    });
    ipcMain.handle(CHANNELS.appSettingsShortcut, async (event, raw: unknown) => {
        const press = appKeyPressSchema.safeParse(raw);
        if (!fromPolaris(event) || !press.success) return null;
        const binding = bindingFromPress(press.data, process.platform);
        if (!binding) return null;
        await setLauncherBinding(binding);
        changed();
        return snapshot();
    });
    ipcMain.handle(CHANNELS.appSettingsClearClipboard, (event) => {
        if (fromPolaris(event)) clearClipboardHistory();
    });
    ipcMain.handle(CHANNELS.appSettingsRelaunch, (event) => (fromPolaris(event) ? host.relaunch() : REFUSED));
    ipcMain.handle(CHANNELS.appSettingsHosts, (event) => {
        if (fromPolaris(event)) host.manageHosts(event.sender);
    });
    ipcMain.handle(CHANNELS.appSettingsResetOverlay, async (event) => {
        if (!fromPolaris(event)) return null;
        resetVoiceWidgetLayout();
        followVoiceWidgetLook();
        changed();
        return snapshot();
    });
    ipcMain.handle(CHANNELS.appSettingsAnnounce, (event, raw: unknown) => {
        // An older page sends nothing: it draws the settings and not the hosts.
        const features = z.array(z.string().max(32)).max(16).catch([]).parse(raw);
        if (fromPolaris(event)) host.settingsAnnounced(event.sender, features.includes("hosts" satisfies SettingsFeature));
    });

    // Settings > This app > Hosts. Each change says so to every Polaris page, so
    // a second window on the screen draws the list anew.
    const hostsChanged = <T extends { ok: boolean }>(outcome: T): T => {
        if (outcome.ok) changed();
        return outcome;
    };
    const HOSTS_REFUSED: HostImport = { ok: false, error: "Polaris could not do that. Try again." };
    ipcMain.handle(CHANNELS.hostsList, (event): HostsSnapshot | null => {
        if (!fromPolaris(event)) return null;
        const state = host.connectState();
        return { servers: state.servers, error: state.error };
    });
    ipcMain.handle(CHANNELS.hostsCheck, (event, raw: unknown) =>
        fromPolaris(event) ? host.connectCheck(raw) : { ok: false, message: null }
    );
    ipcMain.handle(CHANNELS.hostsAdd, async (event, raw: unknown) => {
        const input = z.object({ address: z.string().max(2048), name: z.string().max(200) }).safeParse(raw);
        if (!fromPolaris(event) || !input.success) return REFUSED;
        return hostsChanged(await host.addServer(input.data.address, input.data.name));
    });
    ipcMain.handle(CHANNELS.hostsSwitch, (event, raw: unknown) => {
        const origin = listedSchema.safeParse(raw);
        return fromPolaris(event) && origin.success ? host.switchServer(origin.data) : REFUSED;
    });
    ipcMain.handle(CHANNELS.hostsEdit, async (event, raw: unknown) => {
        const input = z.object({ origin: listedSchema, address: z.string().max(2048), name: z.string().max(200) }).safeParse(raw);
        if (!fromPolaris(event) || !input.success) return REFUSED;
        return hostsChanged(await host.editServer(input.data.origin, input.data.address, input.data.name));
    });
    ipcMain.handle(CHANNELS.hostsRemove, (event, raw: unknown) => {
        const origin = listedSchema.safeParse(raw);
        return fromPolaris(event) && origin.success ? hostsChanged(host.removeServer(origin.data)) : REFUSED;
    });
    ipcMain.handle(CHANNELS.hostsStatus, (event, raw: unknown): Promise<HostStatus> | HostStatus => {
        const origin = listedSchema.safeParse(raw);
        return fromPolaris(event) && origin.success ? host.hostStatus(origin.data) : "unknown";
    });
    ipcMain.handle(CHANNELS.hostsLink, (event) => (fromPolaris(event) ? host.hosts.link() : ""));
    ipcMain.handle(CHANNELS.hostsCopy, (event) => (fromPolaris(event) ? host.hosts.copy() : { ok: false, count: 0 }));
    ipcMain.handle(CHANNELS.hostsExport, (event) =>
        fromPolaris(event) ? host.hosts.exportFile(BrowserWindow.fromWebContents(event.sender)) : HOSTS_REFUSED
    );
    ipcMain.handle(CHANNELS.hostsOpen, async (event) =>
        fromPolaris(event) ? hostsChanged(await host.hosts.importFile(BrowserWindow.fromWebContents(event.sender))) : HOSTS_REFUSED
    );
    ipcMain.handle(CHANNELS.hostsImport, (event, raw: unknown) => {
        const text = z.string().max(65536).safeParse(raw);
        return fromPolaris(event) && text.success ? hostsChanged(host.hosts.take(text.data)) : HOSTS_REFUSED;
    });
    // Only the host's update page, by its exact address.
    ipcMain.handle(CHANNELS.connectOpenOnHost, (event, raw: unknown) => {
        const path = readHostPath(raw);
        return from(event, "connect") && path !== null ? host.openOnHost(path) : "offline";
    });
    ipcMain.handle(CHANNELS.connectClose, (event) => {
        if (from(event, "connect")) host.closeConnect();
    });

    ipcMain.handle(CHANNELS.keyState, (event) => (from(event, "api-key") ? keyFormState() : null));
    ipcMain.handle(CHANNELS.keySubmit, (event, raw: unknown) => (from(event, "api-key") ? submitApiKey(raw) : REFUSED));
    ipcMain.handle(CHANNELS.keyCancel, (event) => {
        if (from(event, "api-key")) cancelApiKey();
    });
    ipcMain.handle(CHANNELS.keyOpen, (event) => {
        if (from(event, "api-key")) host.showPolaris("/account/api-keys");
    });

    ipcMain.handle(CHANNELS.pushState, (event) => pushOf(event.sender)?.state() ?? null);
    ipcMain.handle(CHANNELS.pushChoose, (event) => pushOf(event.sender)?.chooseFolder() ?? null);
    ipcMain.handle(CHANNELS.pushStart, (event, raw: unknown) => {
        const push = pushOf(event.sender);
        const input = z.object({ platform: z.string().max(32) }).safeParse(raw);
        return push && input.success ? push.start(input.data.platform) : REFUSED;
    });
    ipcMain.handle(CHANNELS.pushCancel, (event) => pushOf(event.sender)?.cancel());
    ipcMain.handle(CHANNELS.pushOpenService, (event) => {
        const push = pushOf(event.sender);
        if (push) host.showPolaris(push.target.href);
    });
}
