/**
 * The launcher: Polaris search from anywhere on the computer, opened with a
 * key held system-wide (Alt+Space unless somebody records another).
 *
 * Built to cost next to nothing while it waits, which is most of the time:
 * - The window is made, hidden, a few seconds after start (`WARM_DELAY_MS`)
 *   and kept: the first press only shows it, so it opens as fast as the
 *   second. Made on that press instead, the press waited for a probe of the
 *   instance, a new renderer and the whole `/launcher` page - seconds, every
 *   time it had been put away for a while. One hidden renderer is the price,
 *   paid only while the launcher is on; the key itself costs one OS
 *   registration.
 * - Nothing runs on a timer except the clipboard history, on unless somebody
 *   turns it off (see `watchClipboard` for why it has to look).
 * - Its preload carries a handful of calls and no shared bundle.
 *
 * The window shows the dashboard's own search: it loads the instance's
 * `/launcher` page (the very `CommandPalette` the header opens) in the main
 * window's session, so recents, results, logos and commands are the same ones,
 * and this module only adds what a browser cannot see - programs, the
 * clipboard, the web - as rows the palette draws after its own. A host from
 * before that page, or no session, answers 404 there; the window then draws
 * its own panel (`renderer/launcher.tsx`) from the rows below.
 * - Polaris's index is asked on open and kept for `INDEX_FRESH_MS`; typing
 *   filters it here without touching the network, as the dashboard's palette
 *   does with the same route (`/api/search`).
 *
 * What a row does is decided here and only here: the page sends the id of the
 * row chosen, never an address or a path.
 */

import { z } from "zod";
import { join } from "node:path";
import { renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CLIPBOARD_KEEP, ClipboardStore } from "@/shared/clipboard-store";
import * as settings from "./settings";
import { openExternal } from "./open-external";
import { holdGlobalKey } from "./call-hotkeys";
import { runningPrograms } from "./game-detect";
import { quickAnswer } from "@/shared/quick-answer";
import type { LauncherStatus } from "@/shared/bridge";
import { takeFocus } from "./window-front";
import { installedApps, installedAppsRead, openListedApp } from "./launcher-apps";
import { CLIPBOARD_LIMIT, isConcealed, withClip, type ClipEntry } from "@/shared/clipboard-history";
import { DEFAULT_LAUNCHER_BINDING, displayAccelerator, launcherAccelerator } from "@/shared/launcher-hotkey";
import { conflictSentence, findLaunchers, likelyHolders, type FoundLauncher } from "@/shared/launcher-conflicts";
import { LAUNCHER_CHANNELS, topMatches, webSearchUrl, type LauncherAnswer, type LauncherRow } from "@/shared/launcher";
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, net, powerMonitor, safeStorage, screen, session, type IpcMainInvokeEvent } from "electron";

/** How long after start the hidden window is made, so it does not compete with the main window's first load. */
export const WARM_DELAY_MS = 4_000;
/** How long Polaris's index is used before an open asks for it again. */
const INDEX_FRESH_MS = 60_000;
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
let warmTimer: NodeJS.Timeout | null = null;
/** Whether the window's page has drawn, so a press can show it straight away. */
let ready = false;
let release: (() => void) | null = null;
/** The accelerator held now, or null. */
let heldAccelerator: string | null = null;
let launchersFound: FoundLauncher[] = [];
/** What each row listed last does, by its id. */
let actions = new Map<string, () => void>();
/** The program behind each app row listed last, for its icon. */
let appPaths = new Map<string, string>();
/** Program icons already asked of the system, by path. Bounded by the list of installed programs. */
const appIcons = new Map<string, string | null>();
/** The instance whose `/launcher` page the window shows, or null for the window's own panel. */
let remote: string | null = null;

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

/** The history between runs: encrypted by the system, or memory only (see `clipboard-store`). */
let store: ClipboardStore | null = null;

function clipboardStore(): ClipboardStore {
    const path = join(app.getPath("userData"), "clipboard-history.bin");
    store ??= new ClipboardStore(
        {
            available: () => safeStorage.isEncryptionAvailable(),
            encrypt: (text) => safeStorage.encryptString(text),
            decrypt: (data) => safeStorage.decryptString(Buffer.from(data))
        },
        {
            read: () => {
                try {
                    return readFileSync(path);
                } catch (caught) {
                    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
                    throw caught;
                }
            },
            write: (data) => {
                const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
                writeFileSync(temp, data, { mode: 0o600 });
                try {
                    renameSync(temp, path);
                } catch (caught) {
                    rmSync(temp, { force: true });
                    throw caught;
                }
            },
            remove: () => rmSync(path, { force: true })
        }
    );
    return store;
}

function keepMs(): number {
    return CLIPBOARD_KEEP[settings.launcherClipboardKeep()];
}

/** Whether the history outlives a restart on this computer. */
export function clipboardPersists(): boolean {
    return clipboardStore().persists();
}

/** The retention changed: prune now, so a shorter time takes effect at once. */
export function followClipboardKeep(): void {
    clips = clipboardStore().save(clips, Date.now(), keepMs());
}

/** Arithmetic only: the palette works that out itself, so the window does not repeat it. */
const SUM = /^[\d\s+\-*/().,^%]+$/;

/**
 * The rows for `text`. `hostOnly` is the dashboard's palette asking: it has
 * Polaris's own rows already, so only what it cannot find is listed.
 */
function rowsFor(text: string, hostOnly = false): LauncherAnswer {
    const query = text.trim();
    const next = new Map<string, () => void>();
    const paths = new Map<string, string>();
    const rows: LauncherRow[] = [];
    const add = (row: Omit<LauncherRow, "id">, action: () => void) => {
        const id = String(rows.length);
        rows.push({ id, ...row });
        next.set(id, action);
    };
    const origin = host?.server() ?? null;

    const answer = hostOnly && SUM.test(query) ? null : quickAnswer(query);
    if (answer) add({ kind: "answer", title: answer.value, subtitle: `${answer.label} - Enter copies it` }, () => void clipboard.writeText(answer.value));

    if (/^clip(\s|$)/i.test(query) && settings.toggle("launcherClipboard")) {
        const rest = query.slice(4).trim();
        const found = rest ? clips.filter((clip) => clip.text.toLowerCase().includes(rest.toLowerCase())) : clips;
        for (const clip of found.slice(0, 20)) {
            add({ kind: "clip", title: clip.text.replace(/\s+/g, " ").slice(0, 200), subtitle: "Clipboard - Enter copies it" }, () => void clipboard.writeText(clip.text));
        }
    } else if (query) {
        if (origin && !hostOnly) {
            for (const entry of topMatches(query, index?.server === origin ? index.entries : [], PER_KIND)) {
                add({ kind: "polaris", title: entry.label, subtitle: entry.context }, () => host?.showPolaris(entry.href));
            }
            for (const page of topMatches(query, PAGES.map((page) => ({ ...page, context: "Polaris" })), 3)) {
                add({ kind: "page", title: page.label, subtitle: "Open in Polaris" }, () => host?.showPolaris(page.path));
            }
        }
        for (const app of topMatches(query, installedApps().map((app) => ({ ...app, context: "" })), PER_KIND)) {
            add({ kind: "app", title: app.label, subtitle: app.launch && app.launch.kind !== "open" ? appSource(app.path) : "Application" }, () => void openListedApp(app.path));
            paths.set(String(rows.length - 1), app.icon ?? app.path);
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
    } else if (origin && !hostOnly) {
        for (const page of PAGES.slice(0, 6)) add({ kind: "page", title: page.label, subtitle: "Open in Polaris" }, () => host?.showPolaris(page.path));
    }
    actions = next;
    appPaths = paths;
    return { rows, notice: origin ? indexNotice : "Connect to a Polaris to search it." };
}

function hide(): void {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    window.hide();
    void upgradeOwnPanel(window);
}

/**
 * The kept window shows its own panel because the instance did not serve its
 * search page when it was made - not signed in yet, offline, an older host.
 * Ask again as it is put away, and make it again for that page once it does, so
 * keeping the window never keeps the fallback.
 */
async function upgradeOwnPanel(kept: BrowserWindow): Promise<void> {
    const origin = host?.server() ?? null;
    if (remote || !origin || !(await servesLauncher(origin))) return;
    if (window !== kept || kept.isDestroyed() || kept.isVisible() || remote) return;
    kept.destroy();
    make();
}

/** What a store's row says under its name, from the `store:id` it is listed by. */
function appSource(path: string): string {
    const store = path.slice(0, path.indexOf(":"));
    return { packaged: "Application", epic: "Epic Games", steam: "Steam", gog: "GOG", ubisoft: "Ubisoft Connect" }[store] ?? "Application";
}

/**
 * The program's own icon as a PNG data URL, asked of the system once per
 * program - or, for a picture a store keeps of its game, that picture.
 */
async function iconOf(path: string): Promise<string | null> {
    if (appIcons.has(path)) return appIcons.get(path) ?? null;
    const picture = /\.(jpe?g|png)$/i.test(path);
    const image = picture
        ? (() => {
              const found = nativeImage.createFromPath(path);
              return found.isEmpty() ? null : found.resize({ width: 32, height: 32, quality: "good" });
          })()
        : await app.getFileIcon(path, { size: "normal" }).catch(() => null);
    const url = image && !image.isEmpty() ? image.toDataURL() : null;
    appIcons.set(path, url && url.startsWith("data:image/png;base64,") && url.length < 200_000 ? url : null);
    return appIcons.get(path) ?? null;
}

/** The rows with each program's icon added. */
async function withIcons(answer: LauncherAnswer): Promise<LauncherAnswer> {
    const rows = await Promise.all(
        answer.rows.map(async (row) => {
            const path = row.kind === "app" ? appPaths.get(row.id) : undefined;
            return path ? { ...row, icon: await iconOf(path) } : row;
        })
    );
    return { ...answer, rows };
}

/**
 * Whether the instance serves the dashboard's own search page to this
 * session: a 200 from `/launcher`. A host from before it, or no session, is a
 * 404 - and anything that is not a quick 200 means the window's own panel.
 */
async function servesLauncher(origin: string): Promise<boolean> {
    try {
        const response = await session.defaultSession.fetch(`${origin}/launcher`, {
            redirect: "manual",
            cache: "no-store",
            signal: AbortSignal.timeout(4000)
        });
        void response.body?.cancel().catch(() => undefined);
        return response.status === 200;
    } catch {
        return false;
    }
}

/** The window's own panel, drawn from the rows here. */
function loadOwnPanel(target: BrowserWindow): void {
    remote = null;
    void target.loadFile(join(__dirname, "..", "renderer", "launcher.html"));
}

function create(): BrowserWindow {
    const made = new BrowserWindow({
        show: false,
        frame: false,
        // The page draws the dashboard's search panel in the middle of a
        // window that covers the work area (see place): the rest is clear,
        // so only the panel shows, where the dashboard's palette would be.
        transparent: true,
        hasShadow: false,
        thickFrame: false,
        roundedCorners: false,
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
        backgroundColor: "#00000000",
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
    // Every Polaris result is opened in the main window; this one never leaves its page.
    made.webContents.on("will-navigate", (event) => event.preventDefault());
    made.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
        // The instance's page did not load (offline, a certificate): the own panel instead.
        if (isMainFrame && remote && code !== -3 && url.startsWith(remote) && !made.isDestroyed()) loadOwnPanel(made);
    });
    made.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Windows hands every window the app menu: here it would only take the Alt key.
    made.removeMenu();
    // Activated later than it was shown (the foreground lock let go): the page takes the keys then too.
    made.on("focus", () => made.webContents.focus());
    made.on("blur", hide);
    made.once("ready-to-show", () => {
        if (window === made) ready = true;
    });
    made.once("closed", () => {
        if (window === made) {
            window = null;
            ready = false;
        }
    });
    const origin = host?.server() ?? null;
    void (origin ? servesLauncher(origin) : Promise.resolve(false)).then((served) => {
        if (made.isDestroyed()) return;
        if (served && origin) {
            remote = origin;
            void made.loadURL(`${origin}/launcher`).catch(() => {
                if (!made.isDestroyed() && remote === origin) loadOwnPanel(made);
            });
        } else loadOwnPanel(made);
    });
    return made;
}

/**
 * Lay the window over the work area of the screen the pointer is on and bring
 * it up. The window is clear and the page centres the panel in it both ways,
 * exactly as the dashboard's dialog centres its palette in a browser window -
 * so the panel lands in the middle of that screen, whatever its size, and grows
 * from the middle as results arrive instead of hanging from a fixed top.
 */
function place(target: BrowserWindow): void {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    target.setBounds(workArea);
    takeFocus(target, process.platform, "pop-up-menu");
    target.webContents.send(LAUNCHER_CHANNELS.opened);
}

/** The key's press: open the launcher, or put it away when it is in front. */
export function toggleLauncher(): void {
    if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
        hide();
        return;
    }
    void refreshIndex();
    installedApps();
    // Pointed at another Polaris since the window was made: make it again for that one.
    const origin = host?.server() ?? null;
    if (window && !window.isDestroyed() && remote && remote !== origin) window.destroy();
    if (window && !window.isDestroyed() && ready) {
        place(window);
        return;
    }
    // Still loading (pressed during the warm-up), or not made yet: show it once it has drawn.
    const made = window && !window.isDestroyed() ? window : make();
    made.once("ready-to-show", () => {
        if (window === made) place(made);
    });
}

function make(): BrowserWindow {
    ready = false;
    window = create();
    return window;
}

/**
 * Make the window ahead of the first press, hidden, for the Polaris in use, and
 * fill the index and the program list it will search - so a press only shows it.
 */
function warm(): void {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = null;
    if (!settings.toggle("launcher")) return;
    const origin = host?.server() ?? null;
    if (window && !window.isDestroyed() && remote && remote !== origin) window.destroy();
    if (!window || window.isDestroyed()) make();
    void refreshIndex();
    installedApps();
}

function warmSoon(): void {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(warm, WARM_DELAY_MS);
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
    else warmSoon();
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
        // Off means kept nowhere: the file goes too.
        clipboardStore().clear();
        return;
    }
    if (clipTimer) return;
    clips = clipboardStore().load(Date.now(), keepMs());
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
    if (!concealed && lastClip === text && settings.toggle("launcherClipboard")) {
        const now = Date.now();
        clips = clipboardStore().save(withClip(clips, text, now, CLIPBOARD_LIMIT), now, keepMs());
    }
}

export function clearClipboardHistory(): void {
    clips = [];
    clipboardStore().clear();
}

/**
 * Whether a call came from the launcher's page: its window, and its top frame
 * on the page it was given - the window's own file, or the instance's
 * `/launcher` - never a frame inside it or a page it was moved to.
 */
function fromLauncher(event: IpcMainInvokeEvent): boolean {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false;
    try {
        const url = new URL(frame.url);
        return remote ? url.origin === new URL(remote).origin && url.pathname === "/launcher" : url.protocol === "file:";
    } catch {
        return false;
    }
}

/** Take the key and answer the launcher page. Called once, when the app is ready. */
export function startLauncher(given: LauncherHost): void {
    host = given;
    ipcMain.handle(LAUNCHER_CHANNELS.query, async (event, raw: unknown, rawMode: unknown) => {
        const text = z.string().max(500).safeParse(raw);
        if (!fromLauncher(event) || !text.success) return { rows: [], notice: null };
        if (rawMode === "host-only") return withIcons(rowsFor(text.data, true));
        // The first keystrokes after opening wait for the index once, briefly.
        if (indexing) await Promise.race([indexing, new Promise((resolve) => setTimeout(resolve, 1500))]);
        return withIcons(rowsFor(text.data));
    });
    ipcMain.handle(LAUNCHER_CHANNELS.open, (event, raw: unknown) => {
        // A path of the instance, from its own palette; never another address.
        const path = z.string().max(2048).regex(/^\/(?!\/)[^\\]*$/).safeParse(raw);
        if (!fromLauncher(event) || !remote || !path.success) return;
        hide();
        host?.showPolaris(path.data);
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
    warmSoon();
    // Refused at start: look once at who has it, so the settings can say.
    if (settings.toggle("launcher") && !heldAccelerator) void lookForLaunchers();
}

/** Let the key go and close the window, as the app quits. */
export function stopLauncher(): void {
    release?.();
    release = null;
    if (clipTimer) clearInterval(clipTimer);
    clipTimer = null;
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = null;
    if (window && !window.isDestroyed()) window.destroy();
}
