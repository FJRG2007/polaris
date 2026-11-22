/**
 * The launcher: Polaris search from anywhere on the computer, opened with a
 * key held system-wide (Alt+Space unless somebody records another).
 *
 * Built to cost next to nothing while it waits, which is most of the time:
 * - The window is made on the first press, not at start, reused while it is
 *   in use, and destroyed after `IDLE_MS` hidden, so a launcher nobody opens
 *   holds no renderer at all. The key itself costs one OS registration.
 * - Nothing runs on a timer except the clipboard history, which is off unless
 *   somebody turns it on (see `watchClipboard` for why it has to look).
 * - Its preload carries five calls and no shared bundle.
 * - Polaris's index is asked on open and kept for `INDEX_FRESH_MS`; typing
 *   filters it here without touching the network, as the dashboard's palette
 *   does with the same route (`/api/search`).
 *
 * What a row does is decided here and only here: the page sends the id of the
 * row chosen, never an address or a path.
 */

import { z } from "zod";
import { join } from "node:path";
import * as settings from "./settings";
import { openExternal } from "./open-external";
import { holdGlobalKey } from "./call-hotkeys";
import { runningPrograms } from "./game-detect";
import { quickAnswer } from "@/shared/quick-answer";
import type { LauncherStatus } from "@/shared/bridge";
import { installedApps, installedAppsRead, isListedApp } from "./launcher-apps";
import { isConcealed, withClip, type ClipEntry } from "@/shared/clipboard-history";
import { DEFAULT_LAUNCHER_BINDING, displayAccelerator, launcherAccelerator } from "@/shared/launcher-hotkey";
import { conflictSentence, findLaunchers, likelyHolders, type FoundLauncher } from "@/shared/launcher-conflicts";
import { LAUNCHER_CHANNELS, topMatches, webSearchUrl, type LauncherAnswer, type LauncherRow } from "@/shared/launcher";
import { BrowserWindow, clipboard, ipcMain, nativeTheme, net, powerMonitor, screen, shell, type IpcMainInvokeEvent } from "electron";

/** Hidden this long, the window is destroyed; the next press makes a new one. */
export const IDLE_MS = 5 * 60_000;
/** How long Polaris's index is used before an open asks for it again. */
const INDEX_FRESH_MS = 60_000;
const WIDTH = 680;
const HEIGHT = 440;
/** The most rows of each kind, so the list stays one screen. */
const PER_KIND = 6;

export interface LauncherHost {
    /** The Polaris in use, or null before one is set. */
    readonly server: () => string | null;
    /** Show the Polaris window at a path of the Polaris in use. */
    readonly showPolaris: (path?: string) => void;
}

let host: LauncherHost | null = null;
let window: BrowserWindow | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let release: (() => void) | null = null;
/** The accelerator held now, or null. */
let heldAccelerator: string | null = null;
let launchersFound: FoundLauncher[] = [];
/** What each row listed last does, by its id. */
let actions = new Map<string, () => void>();

/** The dashboard's own sections, listed even before its index answers. */
const PAGES: readonly { label: string; path: string; }[] = [
    { label: "Home", path: "/home" },
    { label: "Chat", path: "/chat" },
    { label: "Mail", path: "/mail" },
    { label: "Drive", path: "/drive" },
    { label: "Tasks", path: "/tasks" },
    { label: "Notes", path: "/notes" },
    { label: "Calendar", path: "/calendar" },
    { label: "Vault", path: "/vault" },
    { label: "Polar", path: "/polar" },
    { label: "Deploy", path: "/apps/deploy" },
    { label: "Account settings", path: "/account" }
];

const indexSchema = z.object({
    resources: z
        .array(
            z.object({
                id: z.string().max(200),
                kind: z.string().max(40),
                label: z.string().max(300),
                context: z.string().max(500),
                href: z.string().max(2048).regex(/^\/(?!\/)/)
            })
        )
        .max(5000)
});

type IndexEntry = z.infer<typeof indexSchema>["resources"][number];

let index: { readonly server: string; readonly at: number; readonly entries: readonly IndexEntry[]; } | null = null;
let indexNotice: string | null = null;
let indexing: Promise<void> | null = null;

/** Ask the Polaris in use for its index, with the window's own sign-in. */
function refreshIndex(): Promise<void> {
    const origin = host?.server() ?? null;
    if (!origin) {
        indexNotice = "Connect to a Polaris to search it.";
        return Promise.resolve();
    }
    if (index?.server === origin && Date.now() - index.at < INDEX_FRESH_MS) return Promise.resolve();
    indexing ??= (async () => {
        try {
            const response = await net.fetch(`${origin}/api/search`, {
                credentials: "include",
                cache: "no-store",
                signal: AbortSignal.timeout(8000)
            });
            if (response.status === 401 || response.status === 403) {
                index = null;
                indexNotice = "Sign in to Polaris to search it from here.";
                return;
            }
            const parsed = indexSchema.safeParse(response.ok ? await response.json() : null);
            if (!parsed.success) {
                indexNotice = "Polaris did not answer the search. Its pages are still listed.";
                return;
            }
            index = { server: origin, at: Date.now(), entries: parsed.data.resources };
            indexNotice = null;
        } catch {
            indexNotice = index ? null : "Polaris could not be reached. Its pages are still listed.";
        } finally {
            indexing = null;
        }
    })();
    return indexing;
}

let clips: readonly ClipEntry[] = [];

function rowsFor(text: string): LauncherAnswer {
    const query = text.trim();
    const next = new Map<string, () => void>();
    const rows: LauncherRow[] = [];
    const add = (row: Omit<LauncherRow, "id">, action: () => void) => {
        const id = String(rows.length);
        rows.push({ id, ...row });
        next.set(id, action);
    };
    const origin = host?.server() ?? null;

    const answer = quickAnswer(query);
    if (answer) add({ kind: "answer", title: answer.value, subtitle: `${answer.label} - Enter copies it` }, () => void clipboard.writeText(answer.value));

    if (/^clip(\s|$)/i.test(query) && settings.toggle("launcherClipboard")) {
        const rest = query.slice(4).trim();
        const found = rest ? clips.filter((clip) => clip.text.toLowerCase().includes(rest.toLowerCase())) : clips;
        for (const clip of found.slice(0, 20)) {
            add({ kind: "clip", title: clip.text.replace(/\s+/g, " ").slice(0, 200), subtitle: "Clipboard - Enter copies it" }, () => void clipboard.writeText(clip.text));
        }
    } else if (query) {
        if (origin) {
            for (const entry of topMatches(query, index?.server === origin ? index.entries : [], PER_KIND)) {
                add({ kind: "polaris", title: entry.label, subtitle: entry.context }, () => host?.showPolaris(entry.href));
            }
            for (const page of topMatches(query, PAGES.map((page) => ({ ...page, context: "Polaris" })), 3)) {
                add({ kind: "page", title: page.label, subtitle: "Open in Polaris" }, () => host?.showPolaris(page.path));
            }
        }
        for (const app of topMatches(query, installedApps().map((app) => ({ ...app, context: "" })), PER_KIND)) {
            add({ kind: "app", title: app.label, subtitle: "Application" }, () => {
                if (isListedApp(app.path)) void shell.openPath(app.path);
            });
        }
        if (origin) {
            add({ kind: "polar", title: `Ask Polar "${query.slice(0, 120)}"`, subtitle: "Opens Polar with the question ready to send" }, () =>
                host?.showPolaris(`/polar?new=1&prompt=${encodeURIComponent(query.slice(0, 4000))}`)
            );
        }
        const engine = settings.launcherEngine();
        add({ kind: "web", title: `Search the web for "${query.slice(0, 120)}"`, subtitle: "Opens in your browser" }, () => openExternal(webSearchUrl(engine, query)));
        if (settings.toggle("launcherClipboard") && clips.some((clip) => clip.text.toLowerCase().includes(query.toLowerCase()))) {
            add({ kind: "clip", title: "Search clipboard history", subtitle: `Type "clip ${query.slice(0, 40)}"` }, () => undefined);
        }
    } else if (origin) {
        for (const page of PAGES.slice(0, 6)) add({ kind: "page", title: page.label, subtitle: "Open in Polaris" }, () => host?.showPolaris(page.path));
    }
    actions = next;
    return { rows, notice: origin ? indexNotice : "Connect to a Polaris to search it." };
}

function hide(): void {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    window.hide();
    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (window && !window.isDestroyed() && !window.isVisible()) window.destroy();
    }, IDLE_MS);
}

function create(): BrowserWindow {
    const made = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        title: "Polaris search",
        // A panel on macOS comes up over the app in front without bringing
        // Polaris's other windows along.
        ...(process.platform === "darwin" ? { type: "panel" } : {}),
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#16171a" : "#ffffff",
        webPreferences: {
            preload: join(__dirname, "..", "preload", "launcher.js"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            navigateOnDragDrop: false,
            spellcheck: false
        }
    });
    made.setAlwaysOnTop(true, "pop-up-menu");
    made.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    made.webContents.on("will-navigate", (event) => event.preventDefault());
    made.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    made.on("blur", hide);
    made.once("closed", () => {
        if (window === made) window = null;
    });
    void made.loadFile(join(__dirname, "..", "renderer", "launcher.html"));
    return made;
}

/** Centre the window on the screen the pointer is on and bring it up. */
function place(target: BrowserWindow): void {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    target.setBounds({
        x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
        y: Math.round(workArea.y + workArea.height * 0.2),
        width: WIDTH,
        height: HEIGHT
    });
    target.show();
    target.focus();
    target.webContents.send(LAUNCHER_CHANNELS.opened);
}

/** The key's press: open the launcher, or put it away when it is in front. */
export function toggleLauncher(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
        hide();
        return;
    }
    void refreshIndex();
    installedApps();
    if (window && !window.isDestroyed()) {
        place(window);
        return;
    }
    const made = (window = create());
    made.once("ready-to-show", () => {
        if (window === made) place(made);
    });
}

function holdKey(): void {
    release?.();
    release = null;
    heldAccelerator = null;
    if (!settings.toggle("launcher")) return;
    const accelerator = launcherAccelerator(settings.launcherBinding()) ?? launcherAccelerator(DEFAULT_LAUNCHER_BINDING);
    if (!accelerator) return;
    release = holdGlobalKey(accelerator, toggleLauncher);
    if (release) heldAccelerator = accelerator;
}

/** Look once at the launchers installed and running: never on a timer. */
async function lookForLaunchers(): Promise<void> {
    const [apps, running] = await Promise.all([
        installedAppsRead().catch(() => []),
        runningPrograms().catch(() => [] as string[])
    ]);
    launchersFound = findLaunchers(process.platform, apps.map((app) => app.label), running);
}

/** The key as the settings show it, after one fresh look at other launchers. */
export async function launcherStatus(): Promise<LauncherStatus> {
    await lookForLaunchers();
    return status();
}

function status(): LauncherStatus {
    const enabled = settings.toggle("launcher");
    const accelerator = launcherAccelerator(settings.launcherBinding()) ?? launcherAccelerator(DEFAULT_LAUNCHER_BINDING) ?? "Alt+Space";
    const key = displayAccelerator(accelerator, process.platform);
    const held = heldAccelerator === accelerator;
    const problem = enabled && !held ? conflictSentence(key, likelyHolders(accelerator, launchersFound)) : null;
    return { enabled, key, held, problem, others: launchersFound.map((found) => found.name) };
}

/** Hold a newly recorded key. A key the system refuses is not kept, and the
 *  one before it is held again. */
export async function setLauncherBinding(binding: string): Promise<LauncherStatus> {
    if (recordingTimer) clearTimeout(recordingTimer);
    recordingTimer = null;
    const accelerator = launcherAccelerator(binding);
    if (!accelerator) return { ...status(), problem: "That shortcut cannot be used. Include Ctrl, Alt or Cmd, or use a function key." };
    const before = settings.launcherBinding();
    settings.rememberLauncherBinding(binding);
    holdKey();
    if (settings.toggle("launcher") && !heldAccelerator) {
        await lookForLaunchers();
        const refused = status();
        settings.rememberLauncherBinding(before);
        holdKey();
        return { ...status(), problem: refused.problem };
    }
    return status();
}

/** The longest a recording keeps the key let go. */
const RECORDING_MS = 30_000;
let recordingTimer: NodeJS.Timeout | null = null;

/** Let the key go while a new one is recorded, and take it back after. */
export function recordLauncherKey(recording: boolean): void {
    if (recordingTimer) clearTimeout(recordingTimer);
    recordingTimer = null;
    if (recording) {
        release?.();
        release = null;
        heldAccelerator = null;
        // Settings closed mid-recording never say they stopped: take it back anyway.
        recordingTimer = setTimeout(() => {
            recordingTimer = null;
            if (!heldAccelerator) holdKey();
        }, RECORDING_MS);
    } else holdKey();
}

/** The switch in the settings changed: take or let go of the key. */
export function followLauncherSettings(): void {
    holdKey();
    if (!settings.toggle("launcher") && window && !window.isDestroyed()) window.destroy();
    watchClipboard();
}

let clipTimer: NodeJS.Timeout | null = null;
let lastClip = "";

/**
 * Keep what is copied while the history is on. Electron has no event for a
 * clipboard change, and the operating systems' own (Windows'
 * `AddClipboardFormatListener`, macOS's change count) need a native module this
 * app does not ship, so the history looks once a second: one read of the text,
 * compared with the last, skipped while nobody has touched the computer for a
 * minute. Off - the default - nothing runs at all.
 */
function watchClipboard(): void {
    const wanted = settings.toggle("launcherClipboard");
    if (!wanted) {
        if (clipTimer) clearInterval(clipTimer);
        clipTimer = null;
        clips = [];
        lastClip = "";
        return;
    }
    if (clipTimer) return;
    let looking = false;
    void clipboard.readText().then((text) => (lastClip = text), () => undefined);
    clipTimer = setInterval(() => {
        if (looking || powerMonitor.getSystemIdleTime() > 60) return;
        looking = true;
        void lookAtClipboard().finally(() => {
            looking = false;
        });
    }, 1000);
    clipTimer.unref();
}

/** A raw platform format, as Electron's clipboard names one. */
function osFormat(format: string): string {
    return `electron application/osclipboard;format="${format}"`;
}

async function lookAtClipboard(): Promise<void> {
    const text = await clipboard.readText();
    if (text === lastClip) return;
    lastClip = text;
    const concealed = await isConcealed(process.platform, {
        has: (format) => clipboard.has(osFormat(format)).catch(() => false),
        read: async (format) => {
            try {
                const [item] = await clipboard.read();
                const blob = await item?.getType(osFormat(format));
                return blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : null;
            } catch {
                return null;
            }
        }
    }).catch(() => true);
    // Copied again while this looked: the newer copy is the next look's.
    if (!concealed && lastClip === text && settings.toggle("launcherClipboard")) clips = withClip(clips, text, Date.now());
}

export function clearClipboardHistory(): void {
    clips = [];
}

function fromLauncher(event: IpcMainInvokeEvent): boolean {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

/** Take the key and answer the launcher page. Called once, when the app is ready. */
export function startLauncher(given: LauncherHost): void {
    host = given;
    ipcMain.handle(LAUNCHER_CHANNELS.query, async (event, raw: unknown) => {
        const text = z.string().max(500).safeParse(raw);
        if (!fromLauncher(event) || !text.success) return { rows: [], notice: null };
        // The first keystrokes after opening wait for the index once, briefly.
        if (indexing) await Promise.race([indexing, new Promise((resolve) => setTimeout(resolve, 1500))]);
        return rowsFor(text.data);
    });
    ipcMain.handle(LAUNCHER_CHANNELS.run, (event, raw: unknown) => {
        const id = z.string().max(10).safeParse(raw);
        const action = fromLauncher(event) && id.success ? actions.get(id.data) : undefined;
        if (!action) return false;
        hide();
        action();
        return true;
    });
    ipcMain.handle(LAUNCHER_CHANNELS.hide, (event) => {
        if (fromLauncher(event)) hide();
    });
    ipcMain.handle(LAUNCHER_CHANNELS.clearClipboard, (event) => {
        if (fromLauncher(event)) clearClipboardHistory();
    });
    holdKey();
    watchClipboard();
    // Refused at start: look once at who has it, so the settings can say.
    if (settings.toggle("launcher") && !heldAccelerator) void lookForLaunchers();
}

/** Let the key go and close the window, as the app quits. */
export function stopLauncher(): void {
    release?.();
    release = null;
    if (clipTimer) clearInterval(clipTimer);
    clipTimer = null;
    if (window && !window.isDestroyed()) window.destroy();
}
