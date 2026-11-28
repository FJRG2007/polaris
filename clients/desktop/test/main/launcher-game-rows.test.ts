/**
 * Games are listed with the apps and drawn as games, and "games" lists every
 * game and game launcher (Raycast's Game Launcher). Electron and the modules
 * around the launcher are stand-ins; no window, program or store is real.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
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
    ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
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


type Row = { kind: string; title: string; subtitle: string; game?: boolean; store?: string };

const STEAM_GAME = { label: "Hollow Knight", path: "steam:367520", launch: { kind: "uri", uri: "steam://rungameid/367520" } };
const EPIC_GAME = { label: "Fortnite", path: "epic:Fortnite", launch: { kind: "uri", uri: "com.epicgames.launcher://apps/Fortnite?action=launch" } };
const STEAM_CLIENT = { label: "Steam", path: "C:/menu/Steam.lnk" };
const EDITOR = { label: "Notepad", path: "C:/menu/Notepad.lnk" };

async function ask(text: string): Promise<Row[]> {
    const window = windows[0];
    if (!window) throw new Error("No launcher window was made.");
    const query = handlers.get("launcher:query");
    if (!query) throw new Error("The query handler was not registered.");
    const event = { sender: window.webContents, senderFrame: { parent: null, url: "file:///launcher/index.html" } };
    const answer = (await query(event, text, "host-only")) as { rows: Row[] };
    return answer.rows;
}

beforeEach(async () => {
    vi.useFakeTimers();
    windows.length = 0;
    vi.mocked(apps.listedApps).mockReturnValue([STEAM_GAME, EPIC_GAME, STEAM_CLIENT, EDITOR] as never);
    launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
    await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
});

afterEach(() => {
    launcher.stopLauncher();
    vi.useRealTimers();
});

describe("games in the launcher", () => {
    it("lists a store game with the apps, as a game of its store", async () => {
        const rows = await ask("hollow");
        expect(rows.find((row) => row.title === "Hollow Knight")).toMatchObject({ kind: "app", game: true, store: "Steam", subtitle: "Steam" });
    });

    it("keeps a program that is not a store game an application", async () => {
        const rows = await ask("notepad");
        const row = rows.find((found) => found.title === "Notepad");
        expect(row).toMatchObject({ kind: "app", subtitle: "Application" });
        expect(row?.game).toBeUndefined();
    });

    it("lists every game and game launcher for \"games\", and no other program", async () => {
        for (const text of ["games", "Game Launcher", "juegos"]) {
            const titles = (await ask(text)).filter((row) => row.kind === "app").map((row) => row.title);
            expect(titles.sort()).toEqual(["Fortnite", "Hollow Knight", "Steam"]);
        }
    });
});
