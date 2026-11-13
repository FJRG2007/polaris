/**
 * Every request a page can make of the main process, checked at the door.
 *
 * A channel answers only the kind of window it was made for, and the
 * dashboard's channels answer only the main frame of a window that is on the
 * configured Polaris at the moment of the call. Every argument is parsed with a
 * schema before it is used: the dashboard is trusted to be the dashboard, not to
 * be free of a bug that lets somebody else's text reach this bridge.
 */

import { z } from "zod";
import { overlayHeight, titleBarColorsSchema } from "@/shared/title-bar";
import { runningPrograms } from "./game-detect";
import { chooseShare, endShare, listShareSources, SOURCE_ID } from "./screen-share";
import { canDrawOnShare, drawOnShare, stopDrawing } from "./annotate-overlay";
import { strokeSchema } from "@/shared/annotate";
import { setCallHotkeys } from "./call-hotkeys";
import { setVoiceState, voiceWidgetAction } from "./voice-widget";
import { voiceActionSchema, voiceStateSchema } from "@/shared/voice-widget";
import { callHotkeysSchema, type CallHotkeysResult } from "@/shared/call-hotkeys";
import { closeNotice, showNotice } from "./notices";
import { appBadgeSchema, applyAppBadge } from "./app-badge";
import { isServerUrl, serverPath } from "./navigation";
import { FolderRefusal, zipFolder } from "./folder-zip";
import { cancelApiKey, keyFormState, submitApiKey } from "./key-flow";
import { kindOf, openPolarisWindow, type WindowKind } from "./windows";
import { installTool } from "./install-tool";
import * as vpn from "./vpn";
import { openTvInstall, registerTvInstall } from "./tv-install";
import { browserFromName, installRequestSchema, type InstallResult } from "@/shared/install-tools";
import {
    type AddressCheck,
    CHANNELS,
    PREFERENCE_TOGGLES,
    type CustomGameInput,
    type GameActivity,
    type Outcome,
    type PickedFolder,
    type HostImport,
    type Preferences,
    type PreferenceToggle,
    type SystemIdle
} from "@/shared/bridge";
import type { ServerRow } from "@/shared/servers";
import type { UpdateReadyState } from "./update-ready";
import type { UpdateCheck } from "@/shared/update-check";
import { readServerAddress } from "@/shared/server-address";
import { openPush, pushOf, pushTargetSchema, type PushHost } from "./push-local";
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    nativeImage,
    powerMonitor,
    shell,
    type IpcMainInvokeEvent,
    type NativeImage,
    type WebContents
} from "electron";
import { ICON_ACCEPT, iconAcceptable } from "./notice-layout";

export interface IpcHost extends PushHost {
    /** The game running now, as the watcher last saw it. */
    readonly runningGame: () => GameActivity | null;
    /** Whether this page is the main window's, which is the one that reports. */
    readonly isReporter: (sender: WebContents) => boolean;
    readonly setCustomGames: (games: readonly CustomGameInput[]) => void;
    /** The address form's state: the address in use and why it failed to open. */
    readonly preferences: () => Preferences;
    readonly setOpenAtLogin: (open: boolean) => boolean;
    /** Keep whether the graphics card is used from the next start. */
    readonly setHardwareAcceleration: (on: boolean) => boolean;
    readonly setToggle: (name: PreferenceToggle, on: boolean) => boolean;
    /** Close and open the app again, unless something running would be lost. */
    readonly relaunch: () => Outcome;
    readonly connectState: () => { address: string | null; error: string | null; servers: ServerRow[]; };
    readonly connectSubmit: (raw: unknown, name?: string) => Promise<Outcome>;
    readonly connectCheck: (raw: unknown) => Promise<AddressCheck>;
    readonly switchServer: (origin: string) => Promise<Outcome>;
    readonly nameServer: (origin: string, name: string) => Outcome;
    readonly removeServer: (origin: string) => Outcome;
    /** Moving the list of hosts to and from another device. */
    readonly hosts: {
        readonly copy: () => { ok: boolean; count: number };
        readonly exportFile: (parent: BrowserWindow | null) => Promise<HostImport>;
        readonly importFile: (parent: BrowserWindow | null) => Promise<HostImport>;
        readonly take: (text: string) => HostImport;
    };
    /** Put the settings away, from the page itself. */
    readonly closeConnect: () => void;
    /** The window that adds, names, removes and switches servers. */
    readonly openServers: () => void;
    /** The update waiting for a restart, and the restart into it. */
    readonly updates: Pick<UpdateReadyState, "current" | "install" | "offer">;
    /** Ask for a newer version now, from a press. */
    readonly checkUpdates: () => Promise<UpdateCheck>;
    /** What the download a check began came to, once it has. */
    readonly updateDownloaded: () => Promise<UpdateCheck>;
    /** Open the download page of the version announced, if there is one. */
    readonly openUpdatePage: () => boolean;
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

    // The window that asked is the one whose taskbar button carries it.
    ipcMain.handle(CHANNELS.appBadge, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const badge = appBadgeSchema.safeParse(raw);
        if (!badge.success) return false;
        applyAppBadge(BrowserWindow.fromWebContents(event.sender), badge.data);
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
        const input = z.object({ thumbnails: z.boolean().optional() }).optional().safeParse(raw);
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

    ipcMain.handle(CHANNELS.installTool, async (event, raw: unknown): Promise<InstallResult> => {
        const request = installRequestSchema.safeParse(raw);
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!fromPolaris(event) || !request.success || !window) return { ok: false, reason: "refused" };
        return installTool(window, request.data);
    });

    ipcMain.handle(CHANNELS.defaultBrowser, (event): string | null => {
        if (!fromPolaris(event)) return null;
        const name = app.getApplicationNameForProtocol("https://");
        if (/firefox/i.test(name)) return "firefox";
        return browserFromName(name);
    });

    ipcMain.handle(CHANNELS.openServers, (event): void => {
        if (fromPolaris(event)) host.openServers();
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
    ipcMain.handle(CHANNELS.connectRename, (event, raw: unknown) => {
        const input = z.object({ origin: listedSchema, name: z.string().max(200) }).safeParse(raw);
        return from(event, "connect") && input.success ? host.nameServer(input.data.origin, input.data.name) : REFUSED;
    });
    ipcMain.handle(CHANNELS.connectPreferences, (event) => (from(event, "connect") ? host.preferences() : null));
    ipcMain.handle(CHANNELS.connectOpenAtLogin, (event, raw: unknown): boolean => {
        const open = z.boolean().safeParse(raw);
        return from(event, "connect") && open.success && host.setOpenAtLogin(open.data);
    });
    ipcMain.handle(CHANNELS.connectHardwareAcceleration, (event, raw: unknown): boolean => {
        const on = z.boolean().safeParse(raw);
        return from(event, "connect") && on.success && host.setHardwareAcceleration(on.data);
    });
    ipcMain.handle(CHANNELS.connectToggle, (event, raw: unknown): boolean => {
        const input = z
            .object({ name: z.enum(PREFERENCE_TOGGLES), on: z.boolean() })
            .safeParse(raw);
        return from(event, "connect") && input.success && host.setToggle(input.data.name, input.data.on);
    });
    // Takes nothing from the page.
    ipcMain.handle(CHANNELS.connectRelaunch, (event) => (from(event, "connect") ? host.relaunch() : REFUSED));
    ipcMain.handle(CHANNELS.connectCheckUpdates, (event) => (from(event, "connect") ? host.checkUpdates() : null));
    // Takes nothing: waits on the download the app itself began.
    ipcMain.handle(CHANNELS.connectUpdateDownloaded, (event) => (from(event, "connect") ? host.updateDownloaded() : null));
    // Takes nothing, as from the page: only into what the app installed itself.
    ipcMain.handle(CHANNELS.connectRestart, (event) => (from(event, "connect") ? host.updates.install() : REFUSED));
    // Takes nothing: only the page of the version the app itself announced.
    ipcMain.handle(CHANNELS.connectUpdatePage, (event) => from(event, "connect") && host.openUpdatePage());
    ipcMain.handle(CHANNELS.connectClose, (event) => {
        if (from(event, "connect")) host.closeConnect();
    });
    ipcMain.handle(CHANNELS.connectRemove, (event, raw: unknown) => {
        const origin = listedSchema.safeParse(raw);
        return from(event, "connect") && origin.success ? host.removeServer(origin.data) : REFUSED;
    });
    // Moving the list: only the settings window asks, and only text crosses in.
    const HOSTS_REFUSED: HostImport = { ok: false, error: "Polaris could not do that. Try again." };
    ipcMain.handle(CHANNELS.connectHostsCopy, (event) =>
        from(event, "connect") ? host.hosts.copy() : { ok: false, count: 0 }
    );
    ipcMain.handle(CHANNELS.connectHostsExport, (event) =>
        from(event, "connect") ? host.hosts.exportFile(BrowserWindow.fromWebContents(event.sender)) : HOSTS_REFUSED
    );
    ipcMain.handle(CHANNELS.connectHostsOpen, (event) =>
        from(event, "connect") ? host.hosts.importFile(BrowserWindow.fromWebContents(event.sender)) : HOSTS_REFUSED
    );
    ipcMain.handle(CHANNELS.connectHostsImport, (event, raw: unknown) => {
        const text = z.string().max(65536).safeParse(raw);
        return from(event, "connect") && text.success ? host.hosts.take(text.data) : HOSTS_REFUSED;
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
