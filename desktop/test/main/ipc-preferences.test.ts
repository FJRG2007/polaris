/**
 * The settings window's hardware acceleration channels at the door: only the
 * settings window may change it, only a boolean is kept, and the restart takes
 * nothing from the page.
 */

import type { IpcHost } from "@/main/ipc";
import { CHANNELS } from "@/shared/bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    dialog: {},
    app: { getPath: () => "", isPackaged: false, on: () => undefined },
    screen: {},
    desktopCapturer: {},
    session: {},
    shell: {},
    net: {},
    nativeImage: {},
    Notification: class {},
    safeStorage: {}
}));

const kinds = vi.hoisted(() => new Map<number, string>());
vi.mock("@/main/windows", () => ({
    kindOf: (sender: { id: number; }) => kinds.get(sender.id) ?? null,
    openPolarisWindow: vi.fn()
}));

const ORIGIN = "https://polaris.example.test";

function event(kind: string) {
    const frame = { url: "file:///connect.html" };
    const sender = { id: kinds.size + 1, mainFrame: frame };
    kinds.set(sender.id, kind);
    return { sender, senderFrame: frame };
}

const host = {
    setHardwareAcceleration: vi.fn((_on: boolean) => true),
    relaunch: vi.fn(() => ({ ok: true as const }))
};

beforeEach(async () => {
    handlers.clear();
    host.setHardwareAcceleration.mockClear();
    host.relaunch.mockClear();
    const { registerIpc } = await import("@/main/ipc");
    registerIpc({ server: () => ORIGIN, ...host } as unknown as IpcHost);
});

describe("hardware acceleration", () => {
    it.each([[true], [false]])("keeps %s from the settings window", (on) => {
        expect(handlers.get(CHANNELS.connectHardwareAcceleration)?.(event("connect"), on)).toBe(true);
        expect(host.setHardwareAcceleration).toHaveBeenCalledWith(on);
    });

    it.each([["false"], [0], [1], [null], [undefined], [{ on: false }]])("refuses %j, which is not a boolean", (raw) => {
        expect(handlers.get(CHANNELS.connectHardwareAcceleration)?.(event("connect"), raw)).toBe(false);
        expect(host.setHardwareAcceleration).not.toHaveBeenCalled();
    });

    it("refuses any window but the settings window", () => {
        expect(handlers.get(CHANNELS.connectHardwareAcceleration)?.(event("polaris"), false)).toBe(false);
        expect(host.setHardwareAcceleration).not.toHaveBeenCalled();
    });
});

describe("the restart", () => {
    it("restarts from the settings window", () => {
        expect(handlers.get(CHANNELS.connectRelaunch)?.(event("connect"))).toEqual({ ok: true });
        expect(host.relaunch).toHaveBeenCalledTimes(1);
    });

    it("refuses any other window", () => {
        expect(handlers.get(CHANNELS.connectRelaunch)?.(event("polaris"))).toMatchObject({ ok: false });
        expect(host.relaunch).not.toHaveBeenCalled();
    });
});
