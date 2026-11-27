/**
 * "Treat as Game" and "Treat as Application" on a launcher row (Raycast's
 * Ctrl+K actions): each program row offers the other kind, the choice is made
 * through the row's id and nothing else, and it wins over what the launcher
 * finds by itself - in how the row is drawn and in what "games" lists.
 * Electron and the modules around the launcher are stand-ins.
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
    openListedApp: vi.fn(() => false)
}));
vi.mock("../../src/main/game-detect", () => ({ runningPrograms: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../src/main/open-external", () => ({ openExternal: vi.fn() }));
const chosen = vi.hoisted(() => new Map<string, "game" | "app">());
vi.mock("../../src/main/game-kinds", () => ({
    gameKinds: vi.fn(() => chosen),
    setGameKind: vi.fn((path: string, kind: "game" | "app", automatic: "game" | "app") => {
        if (kind === automatic) chosen.delete(path);
        else chosen.set(path, kind);
    })
}));

const launcher = await import("../../src/main/launcher");
const apps = await import("../../src/main/launcher-apps");
const kinds = await import("../../src/main/game-kinds");

type Row = { version?: number; id: string; kind: string; title: string; subtitle: string; game?: boolean; store?: string; actions?: string[] };

const STEAM_GAME = { label: "Hollow Knight", path: "steam:367520", launch: { kind: "uri", uri: "steam://rungameid/367520" } };
const EMULATOR = { label: "Dolphin", path: "C:/menu/Dolphin.lnk", target: "C:/Tools/Dolphin/Dolphin.exe" };
const EDITOR = { label: "Notepad", path: "C:/menu/Notepad.lnk" };

function launcherEvent(sender?: unknown) {
    const window = windows[0];
    if (!window) throw new Error("No launcher window was made.");
    return { sender: sender ?? window.webContents, senderFrame: { parent: null, url: "file:///launcher/index.html" } };
}

async function ask(text: string): Promise<Row[]> {
    const query = handlers.get("launcher:query");
    if (!query) throw new Error("The query handler was not registered.");
    const answer = (await query(launcherEvent(), text, "host-only")) as { rows: Row[]; version: number };
    // Each row keeps the answer it came from, as a page keeps it beside the rows it draws.
    return answer.rows.map((row) => ({ ...row, version: answer.version }));
}

async function act(row: Row | undefined, action: string, sender?: unknown): Promise<unknown> {
    const handler = handlers.get("launcher:act");
    if (!handler) throw new Error("The act handler was not registered.");
    return handler(launcherEvent(sender), row?.id, action, row?.version);
}

const named = (rows: Row[], title: string) => rows.find((row) => row.title === title);

beforeEach(async () => {
    vi.useFakeTimers();
    windows.length = 0;
    chosen.clear();
    vi.mocked(kinds.setGameKind).mockClear();
    vi.mocked(apps.listedApps).mockReturnValue([STEAM_GAME, EMULATOR, EDITOR] as never);
    launcher.startLauncher({ server: () => null, showPolaris: vi.fn() });
    await vi.advanceTimersByTimeAsync(launcher.WARM_DELAY_MS);
});

afterEach(() => {
    launcher.stopLauncher();
    vi.useRealTimers();
});

describe("treat as game or application", () => {
    it("offers each program row the other kind", async () => {
        expect(named(await ask("hollow"), "Hollow Knight")?.actions).toEqual(["treat-as-app"]);
        expect(named(await ask("dolphin"), "Dolphin")?.actions).toEqual(["treat-as-game"]);
    });

    it("draws a program treated as a game as one, and lists it with the games", async () => {
        expect(await act(named(await ask("dolphin"), "Dolphin"), "treat-as-game")).toBe(true);
        expect(kinds.setGameKind).toHaveBeenCalledWith(EMULATOR.path, "game", "app");
        const row = named(await ask("dolphin"), "Dolphin");
        expect(row).toMatchObject({ game: true, actions: ["treat-as-app"] });
        expect(row?.store).toBeUndefined();
        expect((await ask("games")).filter((found) => found.kind === "app").map((found) => found.title).sort()).toEqual(["Dolphin", "Hollow Knight"]);
    });

    it("draws a store game treated as an application as one, and leaves it out of the games", async () => {
        expect(await act(named(await ask("hollow"), "Hollow Knight"), "treat-as-app")).toBe(true);
        const row = named(await ask("hollow"), "Hollow Knight");
        expect(row).toMatchObject({ kind: "app", subtitle: "Steam", actions: ["treat-as-game"] });
        expect(row?.game).toBeUndefined();
        expect(row?.store).toBeUndefined();
        expect(named(await ask("games"), "Hollow Knight")).toBeUndefined();

        // Back to a game: back to what it is by itself, with its store.
        await act(named(await ask("hollow"), "Hollow Knight"), "treat-as-game");
        expect(chosen.size).toBe(0);
        expect(named(await ask("hollow"), "Hollow Knight")).toMatchObject({ game: true, store: "Steam" });
    });

    it("acts on the row the page drew, even after a newer answer numbered its rows anew", async () => {
        const drawn = named(await ask("dolphin"), "Dolphin");
        const newer = await ask("hollow");
        expect(newer.some((row) => row.id === drawn?.id)).toBe(true);
        expect(await act(drawn, "treat-as-game")).toBe(true);
        expect(kinds.setGameKind).toHaveBeenCalledWith(EMULATOR.path, "game", "app");
        expect(chosen.get(STEAM_GAME.path)).toBeUndefined();
    });

    it("refuses an action that names no answer, or one too old to remember", async () => {
        const drawn = named(await ask("dolphin"), "Dolphin");
        expect(await act(drawn && { ...drawn, version: undefined }, "treat-as-game")).toBe(false);
        for (let typed = 0; typed < 8; typed += 1) await ask(`dol${typed}`);
        expect(await act(drawn, "treat-as-game")).toBe(false);
        expect(kinds.setGameKind).not.toHaveBeenCalled();
    });

    it("refuses a row that is not a program, an unknown action, and any other page", async () => {
        const rows = await ask("dolphin");
        const web = rows.find((row) => row.kind === "web");
        expect(web?.actions).toBeUndefined();
        expect(await act(web, "treat-as-game")).toBe(false);
        expect(await act(named(rows, "Dolphin"), "delete")).toBe(false);
        expect(await act(named(rows, "Dolphin"), "treat-as-game", { other: true })).toBe(false);
        expect(kinds.setGameKind).not.toHaveBeenCalled();
    });
});
