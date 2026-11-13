/**
 * The voice widget's channels at the door: only the Polaris page reports a
 * call, only the widget window presses its buttons, and each payload is parsed
 * before anything acts on it.
 */

import type { IpcHost } from "@/main/ipc";
import { CHANNELS } from "@/shared/bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const widget = vi.hoisted(() => ({ setVoiceState: vi.fn(), voiceWidgetAction: vi.fn(() => true) }));
vi.mock("@/main/voice-widget", () => widget);

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler), on: () => undefined },
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
    const frame = { url: kind === "polaris" ? `${ORIGIN}/chat` : "file:///widget.html" };
    const sender = { id: kinds.size + 1, mainFrame: frame };
    kinds.set(sender.id, kind);
    return { sender, senderFrame: frame };
}

const STATE = {
    participants: [{ id: "p1", name: "Ada Lovelace", speaking: true, muted: false, deafened: false }],
    selfMuted: false,
    selfDeafened: true
};

beforeEach(async () => {
    handlers.clear();
    widget.setVoiceState.mockClear();
    widget.voiceWidgetAction.mockClear();
    const { registerIpc } = await import("@/main/ipc");
    registerIpc({ server: () => ORIGIN, setToggle: () => true } as unknown as IpcHost);
});

describe("the call's state", () => {
    it("is taken from the Polaris page", () => {
        const from = event("polaris");
        expect(handlers.get(CHANNELS.voiceState)?.(from, STATE)).toBe(true);
        expect(widget.setVoiceState).toHaveBeenCalledWith(from.sender, STATE);
    });

    it("ends with null", () => {
        expect(handlers.get(CHANNELS.voiceState)?.(event("polaris"), null)).toBe(true);
        expect(widget.setVoiceState).toHaveBeenCalledWith(expect.anything(), null);
    });

    it.each([
        [{ ...STATE, extra: 1 }],
        [{ ...STATE, participants: [{ ...STATE.participants[0], speaking: "yes" }] }],
        [{ ...STATE, participants: Array.from({ length: 51 }, () => STATE.participants[0]) }],
        [{ participants: [] }],
        ["state"]
    ])("hides the widget on a shape that does not parse: %j", (raw) => {
        expect(handlers.get(CHANNELS.voiceState)?.(event("polaris"), raw)).toBe(false);
        expect(widget.setVoiceState).toHaveBeenCalledWith(expect.anything(), null);
    });

    it.each([["connect"], ["voice-widget"], ["overlay"]])("refuses the %s window", (kind) => {
        expect(handlers.get(CHANNELS.voiceState)?.(event(kind), STATE)).toBe(false);
        expect(widget.setVoiceState).not.toHaveBeenCalled();
    });
});

describe("the widget's buttons", () => {
    it.each([["mic"], ["deafen"], ["leave"]])("hand %s to the call", (action) => {
        expect(handlers.get(CHANNELS.widgetAction)?.(event("voice-widget"), action)).toBe(true);
        expect(widget.voiceWidgetAction).toHaveBeenCalledWith(action);
    });

    it("refuses anything but the three", () => {
        expect(handlers.get(CHANNELS.widgetAction)?.(event("voice-widget"), "camera")).toBe(false);
        expect(widget.voiceWidgetAction).not.toHaveBeenCalled();
    });

    it("refuses any window but the widget", () => {
        expect(handlers.get(CHANNELS.widgetAction)?.(event("polaris"), "leave")).toBe(false);
        expect(widget.voiceWidgetAction).not.toHaveBeenCalled();
    });
});

describe("the widget's switches", () => {
    it.each([["voiceWidget"], ["voiceWidgetGameOnly"]])("are kept from the settings window: %s", (name) => {
        expect(handlers.get(CHANNELS.connectToggle)?.(event("connect"), { name, on: true })).toBe(true);
    });
});
