/**
 * The update channels at the door: only a Polaris page asks for the waiting
 * update or restarts into it, and the restart takes no argument from the page.
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

function event(kind: string | null, url = `${ORIGIN}/home`) {
    const frame = { url };
    const sender = { id: kinds.size + 1, mainFrame: frame };
    if (kind) kinds.set(sender.id, kind);
    return { sender, senderFrame: frame };
}

const updates = { current: vi.fn(() => ({ version: "0.1.3" })), install: vi.fn(() => ({ ok: true as const })) };

beforeEach(async () => {
    handlers.clear();
    updates.current.mockClear();
    updates.install.mockClear();
    const { registerIpc } = await import("@/main/ipc");
    registerIpc({ server: () => ORIGIN, updates } as unknown as IpcHost);
});

describe("the update channels", () => {
    it("tell a Polaris page the waiting update", () => {
        expect(handlers.get(CHANNELS.updateCurrent)?.(event("polaris"))).toEqual({ version: "0.1.3" });
    });

    it("tell nothing to another window or another site", () => {
        expect(handlers.get(CHANNELS.updateCurrent)?.(event("connect"))).toBeNull();
        expect(handlers.get(CHANNELS.updateCurrent)?.(event("polaris", "https://elsewhere.example.test/"))).toBeNull();
        expect(updates.current).not.toHaveBeenCalled();
    });

    it("restart into the update for a Polaris page", () => {
        expect(handlers.get(CHANNELS.installUpdate)?.(event("polaris"))).toEqual({ ok: true });
        expect(updates.install).toHaveBeenCalledTimes(1);
    });

    it("refuse a restart from elsewhere, or one that names anything", () => {
        expect(handlers.get(CHANNELS.installUpdate)?.(event("push"))).toMatchObject({ ok: false });
        expect(handlers.get(CHANNELS.installUpdate)?.(event("polaris", "https://elsewhere.example.test/"))).toMatchObject({ ok: false });
        expect(handlers.get(CHANNELS.installUpdate)?.(event("polaris"), "C:\evil.exe")).toMatchObject({ ok: false });
        expect(updates.install).not.toHaveBeenCalled();
    });
});
