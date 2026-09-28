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
import { runningPrograms } from "./game-detect";
import { closeNotice, showNotice } from "./notices";
import { isServerUrl, serverPath } from "./navigation";
import { FolderRefusal, zipFolder } from "./folder-zip";
import { cancelApiKey, keyFormState, submitApiKey } from "./key-flow";
import { kindOf, openPolarisWindow, type WindowKind } from "./windows";
import {
    CHANNELS,
    type CustomGameInput,
    type GameActivity,
    type Outcome,
    type PickedFolder
} from "@/shared/bridge";
import { openPush, pushOf, pushTargetSchema, type PushHost } from "./push-local";
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

export interface IpcHost extends PushHost {
    /** The game running now, as the watcher last saw it. */
    readonly runningGame: () => GameActivity | null;
    /** Whether this page is the main window's, which is the one that reports. */
    readonly isReporter: (sender: WebContents) => boolean;
    readonly setCustomGames: (games: readonly CustomGameInput[]) => void;
    /** The address form's state: the address in use and why it failed to open. */
    readonly connectState: () => { address: string | null; error: string | null; };
    readonly connectSubmit: (raw: unknown) => Promise<Outcome>;
}

const noticeSchema = z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(1000).optional(),
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

const windowSchema = z.object({
    path: z.string().min(1).max(2048),
    title: z.string().trim().min(1).max(200)
});

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

    ipcMain.handle(CHANNELS.notify, (event, raw: unknown): boolean => {
        if (!fromPolaris(event)) return false;
        const input = noticeSchema.safeParse(raw);
        if (!input.success) return false;
        const window = BrowserWindow.fromWebContents(event.sender);
        const { href } = input.data;
        return showNotice({
            title: input.data.title,
            body: input.data.body,
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

    ipcMain.handle(CHANNELS.connectState, (event) => (from(event, "connect") ? host.connectState() : null));
    ipcMain.handle(CHANNELS.connectSubmit, (event, raw: unknown) =>
        from(event, "connect") ? host.connectSubmit(raw) : REFUSED
    );

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
