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
    constructor(readonly options: { webPreferences?: Record<string, unknown> } = {}) {
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
    listedApps: vi.fn(() => []),
    installedAppsRead: vi.fn(() => Promise.resolve()),
    openListedApp: vi.fn(() => false),
    installedGames: vi.fn(() => [])
}));
vi.mock("../../src/main/game-detect", () => ({ runningPrograms: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../src/main/open-external", () => ({ openExternal: vi.fn() }));

const launcher = await import("../../src/main/launcher");
const apps = await import("../../src/main/launcher-apps");

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

    it("tells the page when it is put away by a lost focus, so the next open is fresh", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        first().emit("ready-to-show");
        launcher.toggleLauncher();
        first().webContents.send.mockClear();
        first().emit("blur");
        expect(first().isVisible()).toBe(false);
        expect(first().webContents.send).toHaveBeenCalledWith("launcher:hidden");
        launcher.toggleLauncher();
        expect(first().webContents.send).toHaveBeenLastCalledWith("launcher:opened", "");
        expect(first().webContents.focus).toHaveBeenCalledTimes(2);
    });

    it("opens from the main window with what was typed there, and a second ask keeps it up", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        first().emit("ready-to-show");
        expect(launcher.showLauncher("notes")).toBe(true);
        expect(first().isVisible()).toBe(true);
        expect(first().webContents.send).toHaveBeenLastCalledWith("launcher:opened", "notes");
        // Unlike the key, a second ask never puts it away.
        expect(launcher.showLauncher("")).toBe(true);
        expect(first().isVisible()).toBe(true);
        expect(first().webContents.send).toHaveBeenLastCalledWith("launcher:opened", "");
    });

    it("opens from the main window once it has drawn when asked during the warm-up", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        expect(launcher.showLauncher("deploy")).toBe(true);
        expect(windows).toHaveLength(1);
        expect(first().isVisible()).toBe(false);
        first().emit("ready-to-show");
        expect(first().isVisible()).toBe(true);
        expect(first().webContents.send).toHaveBeenLastCalledWith("launcher:opened", "deploy");
    });

    it("never reads the program list on a press, only after the window is put away", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        first().emit("ready-to-show");
        vi.mocked(apps.installedApps).mockClear();
        launcher.toggleLauncher();
        expect(apps.installedApps).not.toHaveBeenCalled();
        launcher.toggleLauncher();
        expect(apps.installedApps).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(launcher.REFRESH_AFTER_HIDE_MS);
        expect(apps.installedApps).toHaveBeenCalledTimes(1);
    });

    it("keeps its hidden page unthrottled, so the first open after idle is not cold", async () => {
        launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
        await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
        expect(first().options.webPreferences?.backgroundThrottling).toBe(false);
    });
});
