/**
 * The update members of the dashboard's bridge: what the app sends is checked
 * before the page hears it, and the page's listeners say whether it draws the
 * button - the first one on, the last one off, a second stop doing nothing.
 */

import { CHANNELS, type PolarisDesktop } from "@/shared/bridge";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined));
const listeners = vi.hoisted(() => new Map<string, Set<(event: unknown, value: unknown) => void>>());
const exposed = vi.hoisted(() => ({ bridge: null as unknown }));

vi.mock("electron", () => ({
    contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => (exposed.bridge = value) },
    ipcRenderer: {
        invoke,
        on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel)?.add(listener);
        },
        removeListener: (channel: string, listener: (event: unknown, value: unknown) => void) => listeners.get(channel)?.delete(listener)
    }
}));
vi.mock("@/shared/title-bar", () => ({ followTitleBarColors: () => undefined }));

let bridge: PolarisDesktop;

beforeAll(async () => {
    await import("@/preload/app");
    bridge = exposed.bridge as PolarisDesktop;
});

beforeEach(() => invoke.mockClear());

const send = (value: unknown) => listeners.get(CHANNELS.updateReady)?.forEach((listener) => listener({}, value));
const offers = () => invoke.mock.calls.filter(([channel]) => channel === CHANNELS.offerUpdate).map(([, on]) => on);

describe("the bridge's update members", () => {
    it("say the page draws the button with its first listener, and stop with its last", () => {
        const stopOne = bridge.onUpdateReady(() => undefined);
        const stopTwo = bridge.onUpdateReady(() => undefined);
        expect(offers()).toEqual([true]);
        stopOne();
        stopOne();
        expect(offers()).toEqual([true]);
        stopTwo();
        expect(offers()).toEqual([true, false]);
    });

    it("hand the page only an update state that is one", async () => {
        const heard = vi.fn();
        const stop = bridge.onUpdateReady(heard);
        send({ version: "0.1.3" });
        send({ version: "0.1.3", restart: "C:\evil.exe" });
        send(null);
        expect(heard.mock.calls).toEqual([[{ version: "0.1.3" }], [null], [null]]);
        stop();

        invoke.mockResolvedValueOnce({ version: "nope" });
        await expect(bridge.updateReady()).resolves.toBeNull();
        invoke.mockResolvedValueOnce({ version: "0.1.3" });
        await expect(bridge.updateReady()).resolves.toEqual({ version: "0.1.3" });
    });

    it("restart through the install channel, naming nothing", async () => {
        invoke.mockResolvedValueOnce({ ok: true });
        await expect(bridge.installUpdate()).resolves.toEqual({ ok: true });
        expect(invoke).toHaveBeenCalledWith(CHANNELS.installUpdate);
    });
});
