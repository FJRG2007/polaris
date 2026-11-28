/**
 * Game mode: while a game or a full-screen window is in front, the launcher
 * lets go of its key so the key reaches the game, and takes it back when the
 * game leaves the front - unless game mode is off. Electron and the modules
 * around the launcher are stand-ins; no key, window or process is real.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windows: FakeWindow[] = [];
const switches = new Set<string>();
const held = new Set<string>();

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
    toggle: vi.fn((name: string) => switches.has(name)),
    launcherBinding: vi.fn(() => "Alt+Space"),
    launcherEngine: vi.fn(() => "google"),
    launcherClipboardKeep: vi.fn(() => "day")
}));
vi.mock("../../src/main/call-hotkeys", () => ({ holdGlobalKey: vi.fn((key: string) => { held.add(key); return () => held.delete(key); }) }));
vi.mock("../../src/main/launcher-apps", () => ({
    installedApps: vi.fn(() => []),
    installedAppsRead: vi.fn(() => Promise.resolve()),
    openListedApp: vi.fn(() => false),
    installedGames: vi.fn(() => [])
}));
vi.mock("../../src/main/game-detect", () => ({ runningPrograms: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../src/main/open-external", () => ({ openExternal: vi.fn() }));


const launcher = await import("../../src/main/launcher");
const hotkeys = await import("../../src/main/call-hotkeys");
const detect = await import("../../src/main/game-detect");
const apps = await import("../../src/main/launcher-apps");
vi.mocked(apps.installedAppsRead).mockResolvedValue([]);

beforeEach(() => {
    switches.clear();
    switches.add("launcher");
    switches.add("launcherGameMode");
    launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
});

afterEach(() => {
    launcher.followGameForeground(false);
    launcher.stopLauncher();
});

describe("game mode", () => {
    it("lets go of the key while a game is in front and takes it back after", async () => {
        expect([...held]).toEqual(["Alt+Space"]);
        launcher.followGameForeground(true);
        expect(held.size).toBe(0);
        // Let go on purpose: the settings do not call it taken by someone else.
        expect((await launcher.launcherStatus()).problem).toBeNull();
        launcher.followGameForeground(false);
        expect([...held]).toEqual(["Alt+Space"]);
    });

    it("keeps the key with game mode off", () => {
        switches.delete("launcherGameMode");
        launcher.followGameForeground(true);
        expect([...held]).toEqual(["Alt+Space"]);
    });

    it("takes the key back the moment game mode is turned off mid-game", () => {
        launcher.followGameForeground(true);
        expect(held.size).toBe(0);
        switches.delete("launcherGameMode");
        launcher.followLauncherSettings();
        expect([...held]).toEqual(["Alt+Space"]);
    });
});

describe("the settings' view of the key", () => {
    it("answers at once when the key is refused, and looks at other launchers in the background", async () => {
        launcher.stopLauncher();
        vi.mocked(hotkeys.holdGlobalKey).mockReturnValue(null);
        let listed: (names: string[]) => void = () => undefined;
        vi.mocked(detect.runningPrograms).mockImplementation(() => new Promise((resolve) => (listed = resolve)));
        try {
            launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
            const onLooked = vi.fn();
            // The look started at launch is still listing programs, and the answer does not wait on it.
            const status = await launcher.launcherStatus(onLooked);
            expect(status.held).toBe(false);
            await launcher.launcherStatus(onLooked);
            // Both reads share the one look under way.
            expect(detect.runningPrograms).toHaveBeenCalledTimes(1);
            listed([]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            // Nothing found, so nothing the settings say changed.
            expect(onLooked).not.toHaveBeenCalled();
        } finally {
            vi.mocked(hotkeys.holdGlobalKey).mockImplementation((key: string) => {
                held.add(key);
                return () => held.delete(key);
            });
            vi.mocked(detect.runningPrograms).mockImplementation(() => Promise.resolve([]));
        }
    });
});
