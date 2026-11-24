/**
 * The launcher opens on the first press as fast as on the second: its window
 * is made hidden shortly after start and kept, instead of being made on the
 * press and destroyed after a while hidden. Electron and the modules around the
 * launcher are stand-ins; no window, key or process is real.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windows: FakeWindow[] = [];

class FakeWindow extends EventEmitter {
    visible = false;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        focus: vi.fn(),
        setWindowOpenHandler: vi.fn()
    });
    constructor() {
        super();
        windows.push(this);
    }
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn(() => Promise.resolve());
    focus = vi.fn();
    removeMenu = vi.fn();
    minimize = vi.fn();
    restore = vi.fn();
    show(): void {
        this.visible = true;
    }
    hide(): void {
        this.visible = false;
    }
    isVisible(): boolean {
        return this.visible;
    }
    isFocused(): boolean {
        return this.visible;
    }
    isDestroyed(): boolean {
        return this.destroyed;
    }
    destroy(): void {
        this.destroyed = true;
        this.emit("closed");
    }
}

vi.mock("electron", () => ({
    app: { getFileIcon: vi.fn(), getPath: vi.fn(() => "") },
    nativeImage: { createFromPath: vi.fn() },
    BrowserWindow: FakeWindow,
    clipboard: { readText: vi.fn(() => "") },
    ipcMain: { handle: vi.fn() },
    net: {},
    powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
    safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
    screen: {
        getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
        getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }))
    },
    session: { defaultSession: { fetch: vi.fn(() => Promise.resolve({ status: 404, body: null })) } },
    shell: {}
}));
vi.mock("../../src/main/settings", () => ({
    toggle: vi.fn((name: string) => name === "launcher"),
    launcherBinding: vi.fn(() => "Alt+Space"),
    launcherEngine: vi.fn(() => "google"),
    launcherClipboardKeep: vi.fn(() => "day")
}));
vi.mock("../../src/main/call-hotkeys", () => ({ holdGlobalKey: vi.fn(() => () => undefined) }));
vi.mock("../../src/main/launcher-apps", () => ({
    installedApps: vi.fn(() => []),
    installedAppsRead: vi.fn(() => Promise.resolve()),
    openListedApp: vi.fn(() => false)
}));
vi.mock("../../src/main/game-detect", () => ({ runningPrograms: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../src/main/open-external", () => ({ openExternal: vi.fn() }));

const launcher = await import("../../src/main/launcher");

/** The one window made, which every test here expects to exist. */
function first(): FakeWindow {
    const made = windows[0];
    if (!made) throw new Error("No launcher window was made.");
    return made;
}

beforeEach(() => {
    vi.useFakeTimers();
    windows.length = 0;
});

afterEach(() => {
    launcher.stopLauncher();
    vi.useRealTimers();
});

describe("the launcher window", () => {
    it("is made hidden shortly after start, before anybody presses the key", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        expect(windows).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        expect(windows).toHaveLength(1);
        expect(first().isVisible()).toBe(false);
    });

    it("shows the window already made on the first press, without making another", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        first().emit("ready-to-show");
        launcher.toggleLauncher();
        expect(windows).toHaveLength(1);
        expect(first().isVisible()).toBe(true);
    });

    it("is kept, not destroyed, however long it stays hidden", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        first().emit("ready-to-show");
        launcher.toggleLauncher();
        launcher.toggleLauncher();
        expect(first().isVisible()).toBe(false);
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(first().isDestroyed()).toBe(false);
        launcher.toggleLauncher();
        expect(windows).toHaveLength(1);
        expect(first().isVisible()).toBe(true);
    });

    it("opens once it has drawn when the key is pressed during the warm-up", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        launcher.toggleLauncher();
        expect(windows).toHaveLength(1);
        expect(first().isVisible()).toBe(false);
        first().emit("ready-to-show");
        expect(first().isVisible()).toBe(true);
    });

    it("hands the keyboard to the page each time it is shown, not only the window", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        first().emit("ready-to-show");
        expect(first().removeMenu).toHaveBeenCalled();
        launcher.toggleLauncher();
        expect(first().focus).toHaveBeenCalled();
        expect(first().webContents.focus).toHaveBeenCalledTimes(1);
        launcher.toggleLauncher();
        launcher.toggleLauncher();
        expect(first().webContents.focus).toHaveBeenCalledTimes(2);
        first().emit("focus");
        expect(first().webContents.focus).toHaveBeenCalledTimes(3);
    });
});
