/**
 * The hidden USB page is a window, and a window left open keeps the app from
 * quitting when the last visible one closes. It lives only while a list or a
 * connection needs it, and a connection hears at once when it goes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { sender: unknown; }, ...args: unknown[]) => void;

const handlers = new Map<string, Handler>();
const windows: FakeWindow[] = [];

class FakeWindow {
    destroyed = false;
    private readonly closedListeners: Array<() => void> = [];
    readonly webContents = {
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
        send: (channel: string, message: unknown) => this.answer(channel, message)
    };

    constructor() {
        windows.push(this);
    }

    on(name: string, listener: () => void): void {
        if (name === "closed") this.closedListeners.push(listener);
    }

    loadFile(): Promise<void> {
        return Promise.resolve();
    }

    isDestroyed(): boolean {
        return this.destroyed;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const listener of this.closedListeners) listener();
    }

    close(): void {
        this.destroy();
    }

    private answer(channel: string, message: unknown): void {
        if (channel !== requestChannel) return;
        const request = message as { id: number; op: string; };
        if (request.op === "list") {
            queueMicrotask(() => reply({ id: request.id, ok: true, devices: [{ id: "s:TV", name: "TV" }] }, this));
            return;
        }
        queueMicrotask(() => reply({ id: request.id, ok: true }, this));
    }
}

let requestChannel = "";
let replyChannel = "";
let lostChannel = "";

function reply(body: unknown, from: FakeWindow): void {
    handlers.get(replyChannel)?.({ sender: from.webContents }, body);
}

vi.mock("electron", () => ({
    BrowserWindow: FakeWindow,
    ipcMain: { on: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    session: {
        fromPartition: () => ({
            setPermissionRequestHandler: () => undefined,
            setPermissionCheckHandler: () => undefined,
            setDevicePermissionHandler: () => undefined,
            on: () => undefined
        })
    }
}));

const { CHANNELS } = await import("@/shared/bridge");
const { usbDevices, usbLink } = await import("@/main/usb-link");
requestChannel = CHANNELS.usbRequest;
replyChannel = CHANNELS.usbReply;
lostChannel = CHANNELS.usbLost;

const live = () => windows.filter((window) => !window.isDestroyed());

describe("the hidden USB window", () => {
    beforeEach(() => {
        for (const window of live()) window.destroy();
        windows.length = 0;
    });

    it("goes once the TVs are listed", async () => {
        expect(await usbDevices()).toEqual([{ id: "s:TV", name: "TV" }]);
        expect(live()).toHaveLength(0);
    });

    it("stays while a connection is open and goes when it closes", async () => {
        const events = { data: vi.fn(), lost: vi.fn() };
        const link = await usbLink("s:TV")(events);
        expect(live()).toHaveLength(1);
        await usbDevices();
        expect(live()).toHaveLength(1);
        link.close();
        await vi.waitFor(() => expect(live()).toHaveLength(0));
        expect(events.lost).not.toHaveBeenCalled();
    });

    it("tells the connection at once when something else closes the window", async () => {
        const events = { data: vi.fn(), lost: vi.fn() };
        await usbLink("s:TV")(events);
        live()[0]?.close();
        expect(events.lost).toHaveBeenCalledTimes(1);
    });

    it("goes when the TV drops the connection", async () => {
        const events = { data: vi.fn(), lost: vi.fn() };
        await usbLink("s:TV")(events);
        const window = live()[0];
        handlers.get(lostChannel)?.({ sender: window?.webContents });
        expect(events.lost).toHaveBeenCalledTimes(1);
        expect(live()).toHaveLength(0);
    });
});
