/**
 * The voice widget's channels at the door: only the Polaris page reports a
 * call, only the widget window presses its buttons, and each payload is parsed
 * before anything acts on it.
 */

import type { IpcHost } from "@/main/ipc";
import { CHANNELS } from "@/shared/bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const widget = vi.hoisted(() => ({
    setVoiceState: vi.fn(),
    voiceWidgetAction: vi.fn(() => true),
    placeVoicePanel: vi.fn(),
    overlayLockStatus: vi.fn(() => ({ key: "Shift+` / Ctrl+Shift+`", problem: null })),
    overlayGames: vi.fn(() => []),
    recordOverlayLockKey: vi.fn(),
    setOverlayLockBinding: vi.fn(() => true),
    setOverlayGame: vi.fn(() => true)
}));
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
    safeStorage: {},
    webContents: { getAllWebContents: () => [] }
}));

const kinds = vi.hoisted(() => new Map<number, string>());
vi.mock("@/main/windows", () => ({
    kindOf: (sender: { id: number; }) => kinds.get(sender.id) ?? null,
    openPolarisWindow: vi.fn()
}));

const ORIGIN = "https://polaris.example.test";

function event(kind: string) {
    const url = kind === "polaris" ? `${ORIGIN}/chat` : "file:///widget.html";
    const frame = { url, origin: new URL(url).origin };
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

describe("a panel dragged in the overlay layer", () => {
    const place = { id: "voice", x: 40, y: 60, width: 260, height: 120, sized: true };

    it("is kept from the layer", () => {
        handlers.get(CHANNELS.widgetPlace)?.(event("voice-widget"), place);
        expect(widget.placeVoicePanel).toHaveBeenCalledWith(place);
    });

    it("refuses an unknown panel, a malformed place and any other window", () => {
        widget.placeVoicePanel.mockClear();
        handlers.get(CHANNELS.widgetPlace)?.(event("voice-widget"), { ...place, id: "chat" });
        handlers.get(CHANNELS.widgetPlace)?.(event("voice-widget"), { ...place, width: 0 });
        handlers.get(CHANNELS.widgetPlace)?.(event("voice-widget"), { ...place, x: 1.5 });
        handlers.get(CHANNELS.widgetPlace)?.(event("polaris"), place);
        expect(widget.placeVoicePanel).not.toHaveBeenCalled();
    });
});

describe("the widget's switches", () => {
    it.each([["voiceWidget"], ["voiceWidgetGameOnly"], ["overlayQuickActions"], ["overlayClickable"], ["voiceWidgetPinned"]])("are kept from the host's Settings > This app: %s", async (name) => {
        const setToggle = vi.fn(() => true);
        handlers.clear();
        const { registerIpc } = await import("@/main/ipc");
        registerIpc({ server: () => ORIGIN, setToggle, preferences: () => ({}), connectState: () => ({ address: ORIGIN, servers: [] }) } as unknown as IpcHost);
        await handlers.get(CHANNELS.appSettingsSet)?.(event("polaris"), { key: name, value: true });
        expect(setToggle).toHaveBeenCalledWith(name, true);
        // The first case imports the whole IPC module, slow on a loaded machine.
    }, 20_000);

    it("are not taken from any other window", async () => {
        expect(await handlers.get(CHANNELS.appSettingsSet)?.(event("connect"), { key: "voiceWidget", value: true })).toBeNull();
    });
});

/** The IPC registered with a host that answers a snapshot. */
async function withSnapshotHost(): Promise<void> {
    handlers.clear();
    const { registerIpc } = await import("@/main/ipc");
    registerIpc({ server: () => ORIGIN, setToggle: () => true, preferences: () => ({}), connectState: () => ({ address: ORIGIN, servers: [] }) } as unknown as IpcHost);
}

describe("the overlay's lock key", () => {
    beforeEach(withSnapshotHost, 20_000);
    const press = { code: "KeyO", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false };

    it("takes a recorded press as its binding and answers the snapshot", async () => {
        widget.setOverlayLockBinding.mockClear();
        const answer = await handlers.get(CHANNELS.appSettingsOverlayShortcut)?.(event("polaris"), press);
        expect(widget.setOverlayLockBinding).toHaveBeenCalledWith("Mod+Alt+O");
        expect(answer).toMatchObject({ overlayLockKey: "Shift+` / Ctrl+Shift+`", features: ["overlayPin", "overlayLockKey", "overlayGames"] });
    });

    it("puts the default keys back for null", async () => {
        widget.setOverlayLockBinding.mockClear();
        await handlers.get(CHANNELS.appSettingsOverlayShortcut)?.(event("polaris"), null);
        expect(widget.setOverlayLockBinding).toHaveBeenCalledWith("");
    });

    it("refuses a bare letter, a key the system will not give, and any other window", async () => {
        widget.setOverlayLockBinding.mockClear();
        const bare = { ...press, ctrlKey: false, altKey: false };
        expect(await handlers.get(CHANNELS.appSettingsOverlayShortcut)?.(event("polaris"), bare)).toBeNull();
        expect(widget.setOverlayLockBinding).not.toHaveBeenCalled();
        widget.setOverlayLockBinding.mockReturnValueOnce(false);
        expect(await handlers.get(CHANNELS.appSettingsOverlayShortcut)?.(event("polaris"), press)).toBeNull();
        expect(await handlers.get(CHANNELS.appSettingsOverlayShortcut)?.(event("voice-widget"), press)).toBeNull();
    });
});

describe("the overlay per game", () => {
    beforeEach(withSnapshotHost, 20_000);
    it("is turned on or off for a game from the host's Settings", async () => {
        widget.setOverlayGame.mockClear();
        const answer = await handlers.get(CHANNELS.appSettingsOverlayGame)?.(event("polaris"), { key: "cs2.exe", on: false });
        expect(widget.setOverlayGame).toHaveBeenCalledWith("cs2.exe", false);
        expect(answer).not.toBeNull();
    });

    it("refuses a malformed change, an unknown game and other windows", async () => {
        widget.setOverlayGame.mockClear();
        expect(await handlers.get(CHANNELS.appSettingsOverlayGame)?.(event("polaris"), { key: "", on: false })).toBeNull();
        expect(await handlers.get(CHANNELS.appSettingsOverlayGame)?.(event("polaris"), { key: "x", on: "no" })).toBeNull();
        expect(widget.setOverlayGame).not.toHaveBeenCalled();
        widget.setOverlayGame.mockReturnValueOnce(false);
        expect(await handlers.get(CHANNELS.appSettingsOverlayGame)?.(event("polaris"), { key: "x", on: true })).toBeNull();
        expect(await handlers.get(CHANNELS.appSettingsOverlayGame)?.(event("connect"), { key: "x", on: true })).toBeNull();
    });
});
