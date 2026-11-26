/**
 * The programs installed on this computer, for the launcher to open. On
 * Windows, in the order Vicinae's `win-app-database.cpp` reads them, each
 * program listed once - as the first source to list it, with the names of
 * every copy: Store and Xbox apps, the Start menu's shortcuts, the Desktop's,
 * the games of Epic, Steam, GOG and Ubisoft (`launcher-stores.ts`), then what
 * only the registry knows (`launcher-programs.ts`: `App Paths`, uninstall
 * entries). On macOS the `.app` bundles in the Applications folders.
 *
 * The listing is kept on disk, so the first open after a restart answers from
 * it instead of waiting on a read; it is read again when the launcher is first
 * warmed, as it is put away once the listing is older than `FRESH_MS`, a short
 * while after a shortcut appears or goes in a folder it watches, and when the
 * game watcher asks after `MAX_AGE_MS` - never on a timer of its own and never
 * on a press, which only shows what was listed. Each is opened the way it
 * was listed - a shortcut through the shell as a double-click would, a game
 * through its store's own link or launcher - never with arguments the launcher
 * made up from typed text. A shortcut is read for its target without
 * resolving it, which can wait on the network.
 *
 * Linux is not indexed: a `.desktop` entry handed to the shell opens in a text
 * editor on most desktops, and running its `Exec` line safely means a parser
 * for the Desktop Entry spec's field codes, which this does not carry yet.
 */

import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import { app, shell } from "electron";
import { spawn } from "node:child_process";
import type { StoreGame } from "./game-detect";
import { exeDescription } from "./launcher-exe-info";
import { shortcutIcon, urlShortcutIcon } from "./launcher-icons";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isPackagedAppId, isVettedLaunchUri, regQuery, storeApps, type AppLaunch } from "./launcher-stores";
import * as programs from "./launcher-programs";

export interface InstalledApp {
    readonly label: string;
    /** Unique per program: the shortcut's path, or a store's `store:id`. */
    readonly path: string;
    /** How it starts; a shortcut or bundle without one is opened by `path`. */
    readonly launch?: AppLaunch;
    /** A file to take its picture from, when that is not `path` itself. */
    readonly icon?: string;
    /** A store game's install folder. */
    readonly folder?: string;
    /** Other names it is found by: its executable's, its folder's, another source's. */
    readonly aliases?: readonly string[];
    /** What a shortcut or entry starts, when known. */
    readonly target?: string;
    /** Its store is updating it (`StoreApp.updating`). */
    readonly updating?: boolean;
}

/** How long a listing is trusted before the next open reads it again. */
const FRESH_MS = 10 * 60_000;
/** The oldest a listing may get while the launcher is not opened: the game watcher reads it again past this (Flow Launcher's 30 h). */
export const MAX_AGE_MS = 30 * 60 * 60_000;
/** A watched folder settles this long after its last change before it is read again, and waits at most `WATCH_MAX_MS`. */
export const WATCH_SETTLE_MS = 3_000;
export const WATCH_MAX_MS = 20_000;
/** The most apps kept, so an odd machine cannot fill memory with shortcuts. */
const MAX_APPS = 4000;
const MAX_DEPTH = 3;
/** Bumped whenever what a listing holds changes, so an older one on disk is read again rather than trusted. */
export const INDEX_VERSION = 3;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

interface Listing {
    readonly apps: readonly InstalledApp[];
    /** Every store game with its folder, kept even when the launcher lists it by a Start menu shortcut. */
    readonly games: readonly StoreGame[];
}

let cached: (Listing & { readonly at: number; }) | null = null;
let reading: Promise<Listing> | null = null;
/** Whether a listing was ever started, so the game watcher starts at most one itself. */
let started = false;
let diskLoaded = false;

const text = (max: number) => z.string().min(1).max(max);
const launchSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open"), path: text(2000) }),
    z.object({ kind: z.literal("uri"), uri: text(2000) }),
    z.object({ kind: z.literal("packaged"), id: text(500) }),
    z.object({ kind: z.literal("exe"), path: text(2000), cwd: text(2000), args: z.array(text(2000)).max(4).optional() })
]);
const indexSchema = z.object({
    version: z.literal(INDEX_VERSION),
    at: z.number().int().nonnegative(),
    apps: z.array(z.object({
        label: text(300),
        path: text(2000),
        launch: launchSchema.optional(),
        icon: text(2000).optional(),
        folder: text(2000).optional(),
        aliases: z.array(text(300)).max(12).optional(),
        target: text(2000).optional(),
        updating: z.boolean().optional()
    })).max(MAX_APPS),
    games: z.array(z.object({ name: text(300), folder: text(2000), store: text(300).optional() })).max(MAX_APPS)
});

/**
 * A listing kept on disk, or null when it is missing, from another version,
 * or not what one looks like. What it says is checked again before anything
 * in it is opened, as a fresh listing's would be.
 */
export function parseIndex(json: unknown): (Listing & { readonly at: number; }) | null {
    const parsed = indexSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
}

/** Where the listing is kept, or null when there is no profile folder to keep it in. */
function indexFile(): string | null {
    try {
        const folder = app.getPath("userData");
        return folder ? join(folder, "launcher-index.json") : null;
    } catch {
        return null;
    }
}

/** The listing kept on disk, read once, so the first open after a restart has something to show. */
function loadIndex(): void {
    if (diskLoaded) return;
    diskLoaded = true;
    const path = indexFile();
    if (!path) return;
    try {
        const raw = readFileSync(path, "utf8");
        if (raw.length <= MAX_INDEX_BYTES) cached ??= parseIndex(JSON.parse(raw));
    } catch {
        // None yet, or unreadable: the first listing writes one.
    }
}

/** Keep a listing on disk, replacing the last one whole: a failed write leaves the old one. */
async function saveIndex(listing: Listing & { readonly at: number; }): Promise<void> {
    const path = indexFile();
    if (!path) return;
    const temp = `${path}.${process.pid}.${listing.at}.tmp`;
    try {
        await writeFile(temp, JSON.stringify({ version: INDEX_VERSION, ...listing }), { mode: 0o600 });
        await rename(temp, path);
    } catch {
        await rm(temp, { force: true }).catch(() => undefined);
    }
}

function roots(platform: NodeJS.Platform): string[] {
    if (platform === "win32") {
        const programs = join("Microsoft", "Windows", "Start Menu", "Programs");
        return [process.env.ProgramData, process.env.APPDATA].filter((dir): dir is string => Boolean(dir)).map((dir) => join(dir, programs));
    }
    if (platform === "darwin") return ["/Applications", "/Applications/Utilities", "/System/Applications", join(homedir(), "Applications")];
    return [];
}

function userDesktop(): string | undefined {
    try {
        return app.getPath("desktop");
    } catch {
        return undefined;
    }
}

/**
 * What an installer drops beside its program that is not a program: its
 * uninstaller, and links to its documents and web pages ("Git Release Notes",
 * "Node.js website", "Inno Setup FAQ", "User manual (PDF, English)").
 * Raycast lists only what opens as an app, and so does this.
 */
const NOT_A_PROGRAM = /\b(uninstall\w*|read ?me|faqs?|release notes|revision history|change ?log|documentation|manuals?|user guide|licen[cs]e|website|web site|support cent(?:er|re)|live support|example scripts)\b/i;

/** Whether a Start menu shortcut's name is a program somebody would open, not its uninstaller or documents. */
export function isProgramShortcut(label: string): boolean {
    return !/^uninstall/i.test(label) && !NOT_A_PROGRAM.test(label);
}

/**
 * What a Windows shortcut starts, or null when it cannot be read. Electron's
 * own reader, which reads what the shortcut stores and does not resolve it
 * (resolving can wait on a network share); only real on Windows.
 */
function readShortcut(path: string): { target: string | null; icon: string | null; } {
    try {
        const link = shell.readShortcutLink(path);
        return { target: link.target && /\.exe$/i.test(link.target) ? link.target : null, icon: shortcutIcon(link, process.env) };
    } catch {
        return { target: null, icon: null };
    }
}

/**
 * What an Internet shortcut opens (`steam://rungameid/570`), so the store's own
 * row and it are one program, and the `IconFile` it is drawn with.
 */
async function readInternetShortcut(path: string): Promise<{ target: string | null; icon: string | null; }> {
    const info = await stat(path).catch(() => null);
    const text = info && info.size <= 64 * 1024 ? await readFile(path, "utf8").catch(() => null) : null;
    return text === null ? { target: null, icon: null } : { target: programs.urlShortcutTarget(text), icon: urlShortcutIcon(text, process.env) };
}

async function walk(platform: NodeJS.Platform, dir: string, depth: number, out: InstalledApp[], maxDepth = MAX_DEPTH): Promise<void> {
    if (out.length >= MAX_APPS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (platform === "darwin") {
            if (entry.isDirectory() && entry.name.endsWith(".app")) out.push({ label: entry.name.slice(0, -4), path });
            continue;
        }
        if (entry.isDirectory()) {
            if (depth < maxDepth) await walk(platform, path, depth + 1, out, maxDepth);
            continue;
        }
        if (!/\.(lnk|url|appref-ms)$/i.test(entry.name)) continue;
        const label = entry.name.replace(/\.(lnk|url|appref-ms)$/i, "");
        if (!isProgramShortcut(label)) continue;
        if (/\.lnk$/i.test(entry.name)) {
            const { target, icon } = readShortcut(path);
            out.push({ label, path, ...(target ? { target, aliases: programs.exeAliases(target) } : {}), ...(icon ? { icon } : {}) });
        } else if (/\.url$/i.test(entry.name)) {
            const { target, icon } = await readInternetShortcut(path);
            out.push({ label, path, ...(target ? { target } : {}), ...(icon ? { icon } : {}) });
        } else {
            out.push({ label, path });
        }
    }
}

const files: programs.ProgramFiles = {
    exists: (path) => stat(path).then((info) => info.isFile(), () => false),
    exes: async (folder) => {
        const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
        return entries.filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name)).slice(0, 200).map((entry) => join(folder, entry.name));
    },
    describe: exeDescription
};

/** What only the registry knows on Windows: `App Paths`, then uninstall entries. */
async function registryPrograms(): Promise<[programs.FoundProgram[], programs.FoundProgram[]]> {
    const [appPaths, uninstall] = await Promise.all([programs.readHives(programs.APP_PATHS_HIVES, regQuery), programs.readHives(programs.UNINSTALL_HIVES, regQuery)]);
    return Promise.all([programs.appPathPrograms(appPaths, files, process.env).catch(() => []), programs.uninstallPrograms(uninstall, files, process.env).catch(() => [])]);
}

async function read(platform: NodeJS.Platform): Promise<Listing> {
    const menu: InstalledApp[] = [];
    for (const root of roots(platform)) await walk(platform, root, 0, menu);
    const desktop: InstalledApp[] = [];
    if (platform === "win32") for (const root of programs.desktopFolders(userDesktop(), process.env)) await walk(platform, root, 0, desktop, 0);
    const [stores, [appPaths, uninstall]] = platform === "win32"
        ? await Promise.all([storeApps().catch(() => []), registryPrograms().catch((): [programs.FoundProgram[], programs.FoundProgram[]] => [[], []])])
        : [[], [[], []] as [programs.FoundProgram[], programs.FoundProgram[]]];
    const packaged = stores.filter((store) => store.launch.kind === "packaged");
    const games = stores.filter((store) => store.launch.kind !== "packaged");
    const apps = programs.mergePrograms<InstalledApp>([packaged, menu, desktop, games, appPaths, uninstall], MAX_APPS);
    const storeGames = stores.flatMap((store) => (store.folder ? [{ name: store.label, folder: store.folder, ...(store.store ? { store: store.store } : {}) }] : []));
    return { apps, games: storeGames };
}

function refresh(platform: NodeJS.Platform): void {
    if (reading) return;
    started = true;
    watchFolders(platform);
    reading = read(platform)
        .then((listing) => {
            cached = { at: Date.now(), ...listing };
            void saveIndex(cached);
            return listing;
        })
        .finally(() => {
            reading = null;
        });
}

let watchers: FSWatcher[] | null = null;
let settle: NodeJS.Timeout | null = null;
let firstChange = 0;

/**
 * When to read a watched folder again after a change: `settle` after the last
 * change, but no later than `max` after the first one, so an installer that
 * writes for a minute is read once it is done and a stream of changes cannot
 * put the read off forever. Pure, for the tests.
 */
export function settleDelay(now: number, first: number, settleMs = WATCH_SETTLE_MS, maxMs = WATCH_MAX_MS): number {
    return Math.max(0, Math.min(settleMs, first + maxMs - now));
}

/** Watch where shortcuts appear - the Start menu, both Desktops, per-user installs - and read again once a change settles. */
function watchFolders(platform: NodeJS.Platform): void {
    if (watchers || (platform !== "win32" && platform !== "darwin")) return;
    watchers = [];
    const folders = platform === "win32"
        ? [...roots(platform), ...programs.desktopFolders(userDesktop(), process.env), ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Programs")] : [])]
        : roots(platform);
    for (const folder of folders) {
        try {
            const watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) => {
                if (name && !/\.(lnk|url|appref-ms|exe|app)$/i.test(String(name))) return;
                const now = Date.now();
                if (!settle) firstChange = now;
                else clearTimeout(settle);
                settle = setTimeout(() => {
                    settle = null;
                    refresh(platform);
                }, settleDelay(now, firstChange));
                settle.unref?.();
            });
            watcher.on("error", () => watcher.close());
            watchers.push(watcher);
        } catch {
            // Missing or not watchable: the next open reads it anyway.
        }
    }
}

/** The installed apps: the last listing straight away (from disk after a restart), read again behind it when stale. */
export function installedApps(platform: NodeJS.Platform = process.platform): readonly InstalledApp[] {
    loadIndex();
    if (!cached || Date.now() - cached.at > FRESH_MS) refresh(platform);
    return cached?.apps ?? [];
}

/**
 * The installed apps as last listed, for a press and the rows it draws: never
 * read again here, since reading spawns the system's slow listing
 * (`Get-StartApps`) and on a press it competes with the window coming up.
 * `installedApps` refreshes it as the launcher is put away. Only a launcher
 * that has never listed anything starts the first listing.
 */
export function listedApps(platform: NodeJS.Platform = process.platform): readonly InstalledApp[] {
    if (!started) return installedApps(platform);
    return cached?.apps ?? [];
}

/** The installed apps once a listing has been read, for the conflict check. */
export async function installedAppsRead(platform: NodeJS.Platform = process.platform): Promise<readonly InstalledApp[]> {
    installedApps(platform);
    return (await reading)?.apps ?? cached?.apps ?? [];
}

/**
 * The installed store games and their folders from the last listing, for the
 * game watcher, which asks on every look: answered from memory. It starts a
 * listing only when none was ever started (the launcher switched off, say) or
 * the last one is older than `MAX_AGE_MS`.
 */
export function installedGames(platform: NodeJS.Platform = process.platform): readonly StoreGame[] {
    if (platform === "win32") {
        loadIndex();
        if (!started || !cached || Date.now() - cached.at > MAX_AGE_MS) refresh(platform);
    }
    return cached?.games ?? [];
}

/** Whether `path` is one of the apps listed, so only those can be opened. */
export function isListedApp(path: string): boolean {
    return cached?.apps.some((app) => app.path === path) ?? false;
}

/** Start a program detached from Polaris, so closing one never closes the other. */
function start(file: string, args: readonly string[], cwd?: string): void {
    try {
        const child = spawn(file, args, { cwd, detached: true, stdio: "ignore", windowsHide: false, shell: false });
        child.on("error", () => undefined);
        child.unref();
    } catch {
        // Gone since it was listed: nothing to start.
    }
}

/** Open the listed app with this `path`, the way it was listed. Anything not listed is ignored. */
export function openListedApp(path: string): boolean {
    const app = cached?.apps.find((candidate) => candidate.path === path);
    if (!app) return false;
    const launch = app.launch ?? { kind: "open", path: app.path };
    switch (launch.kind) {
        case "open":
            void shell.openPath(launch.path);
            return true;
        case "uri":
            if (!isVettedLaunchUri(launch.uri)) return false;
            void shell.openExternal(launch.uri).catch(() => undefined);
            return true;
        case "packaged":
            if (!isPackagedAppId(launch.id)) return false;
            start(join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [`shell:AppsFolder\\${launch.id}`]);
            return true;
        case "exe":
            if (!/\.exe$/i.test(launch.path)) return false;
            start(launch.path, launch.args ?? [], launch.cwd);
            return true;
    }
}
