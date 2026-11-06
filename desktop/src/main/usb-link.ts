/**
 * A TV's USB connection, as an `AdbLink` for `adb-client.ts`.
 *
 * WebUSB is only in pages, so a hidden window (`renderer/usb.ts`) holds the
 * device and this side passes it packets. That window has a session of its own,
 * kept in memory: USB is allowed there and nowhere else, every other permission
 * is refused, and no Polaris page ever loads in it. Devices are granted by
 * `setDevicePermissionHandler`, so no chooser and no click are needed.
 */

import { z } from "zod";
import { join } from "node:path";
import type { AdbLinkEvents, AdbLinkOpener } from "./adb-client";
import { CHANNELS, type TvUsbDevice, type UsbRequest } from "@/shared/bridge";
import { BrowserWindow, ipcMain, session, type IpcMainEvent, type WebContents } from "electron";

const PARTITION = "polaris-tv-usb";
const REQUEST_MS = 15_000;

const replySchema = z.union([
    z.object({
        id: z.number().int(),
        ok: z.literal(true),
        devices: z.array(z.object({ id: z.string().max(200), name: z.string().max(200) })).max(64).optional()
    }),
    z.object({ id: z.number().int(), ok: z.literal(false), error: z.enum(["busy", "gone"]) })
]);

type Reply = z.infer<typeof replySchema>;

/** A USB failure carries the outcome code `connectFailure` reads. */
export function usbError(reason: "busy" | "gone"): Error {
    return Object.assign(new Error(`usb-${reason}`), { code: reason === "busy" ? "USB_BUSY" : "USB_GONE" });
}

let page: Promise<WebContents> | null = null;
let nextId = 1;
const waiting = new Map<number, (reply: Reply) => void>();
/** The connection currently open, which hears the packets the page reads. */
let listener: AdbLinkEvents | null = null;
let registered = false;

let worker: BrowserWindow | null = null;

function fromPage(event: IpcMainEvent): boolean {
    return worker !== null && !worker.isDestroyed() && event.sender === worker.webContents;
}

function register(): void {
    if (registered) return;
    registered = true;
    const own = session.fromPartition(PARTITION);
    own.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    own.setPermissionCheckHandler((_contents, permission) => permission === "usb");
    own.setDevicePermissionHandler((details) => details.deviceType === "usb");
    own.on("select-usb-device", (event, _details, callback) => {
        event.preventDefault();
        callback();
    });
    ipcMain.on(CHANNELS.usbReply, (event, raw: unknown) => {
        if (!fromPage(event)) return;
        const reply = replySchema.safeParse(raw);
        if (!reply.success) return;
        waiting.get(reply.data.id)?.(reply.data);
        waiting.delete(reply.data.id);
    });
    ipcMain.on(CHANNELS.usbIn, (event, raw: unknown) => {
        if (!fromPage(event) || !(raw instanceof Uint8Array)) return;
        listener?.data(Buffer.from(raw));
    });
    ipcMain.on(CHANNELS.usbLost, (event) => {
        if (!fromPage(event)) return;
        const heard = listener;
        listener = null;
        heard?.lost(new Error("The TV closed the connection."));
    });
}

function contents(): Promise<WebContents> {
    register();
    if (page && worker && !worker.isDestroyed()) return page;
    const window = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: join(__dirname, "..", "preload", "usb.js"),
            partition: PARTITION,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            backgroundThrottling: false
        }
    });
    worker = window;
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("closed", () => {
        if (worker === window) {
            worker = null;
            page = null;
        }
    });
    page = window
        .loadFile(join(__dirname, "..", "renderer", "usb.html"))
        .then(() => window.webContents)
        .catch((caught: unknown) => {
            page = null;
            window.destroy();
            throw caught;
        });
    return page;
}

type Ask = { readonly op: "list"; } | { readonly op: "open"; readonly device: string; } | { readonly op: "close"; };

async function ask(request: Ask): Promise<Reply> {
    const target = await contents();
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            waiting.delete(id);
            reject(usbError("busy"));
        }, REQUEST_MS);
        waiting.set(id, (reply) => {
            clearTimeout(timer);
            resolve(reply);
        });
        const message: UsbRequest = { ...request, id };
        target.send(CHANNELS.usbRequest, message);
    });
}

/** The TVs plugged in now that offer ADB. */
export async function usbDevices(): Promise<TvUsbDevice[]> {
    const reply = await ask({ op: "list" });
    return reply.ok ? [...(reply.devices ?? [])] : [];
}

/** The link to the device `id` from `usbDevices`. */
export function usbLink(id: string): AdbLinkOpener {
    return async (events) => {
        const reply = await ask({ op: "open", device: id });
        if (!reply.ok) throw usbError(reply.error);
        const target = await contents();
        listener = events;
        return {
            send: (header, data) => {
                if (listener === events) target.send(CHANNELS.usbOut, new Uint8Array(header), new Uint8Array(data));
            },
            close: () => {
                if (listener !== events) return;
                listener = null;
                void ask({ op: "close" }).catch(() => undefined);
            }
        };
    };
}
