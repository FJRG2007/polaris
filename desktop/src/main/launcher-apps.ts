/**
 * The programs installed on this computer, for the launcher to open: on
 * Windows the Start menu's shortcuts, then what Windows' own search misses -
 * Store and Xbox apps and the games of Epic, Steam, GOG and Ubisoft
 * (`launcher-stores.ts`); on macOS the `.app` bundles in the Applications
 * folders. Read from the file system when the launcher first opens and again
 * on an open after `FRESH_MS`, never on a timer, and opened the way each was
 * listed - a shortcut through the shell as a double-click would, a game through
 * its store's own link - never with arguments the launcher made up.
 *
 * Linux is not indexed: a `.desktop` entry handed to the shell opens in a text
 * editor on most desktops, and running its `Exec` line safely means a parser
 * for the Desktop Entry spec's field codes, which this does not carry yet.
 */

import { join } from "node:path";
import { shell } from "electron";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import type { StoreGame } from "./game-detect";
import { isPackagedAppId, isVettedLaunchUri, storeApps, type AppLaunch } from "./launcher-stores";

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
}

/** How long a listing is trusted before the next open reads it again. */
const FRESH_MS = 10 * 60_000;
/** The most apps kept, so an odd machine cannot fill memory with shortcuts. */
const MAX_APPS = 4000;
const MAX_DEPTH = 3;

interface Listing {
    readonly apps: readonly InstalledApp[];
    /** Every store game with its folder, kept even when the launcher lists it by a Start menu shortcut. */
    readonly games: readonly StoreGame[];
}

let cached: (Listing & { readonly at: number; }) | null = null;
let reading: Promise<Listing> | null = null;
/** Whether a listing was ever started, so the game watcher starts at most one itself. */
let started = false;

function roots(platform: NodeJS.Platform): string[] {
    if (platform === "win32") {
        const programs = join("Microsoft", "Windows", "Start Menu", "Programs");
        return [process.env.ProgramData, process.env.APPDATA].filter((dir): dir is string => Boolean(dir)).map((dir) => join(dir, programs));
    }
    if (platform === "darwin") return ["/Applications", "/Applications/Utilities", "/System/Applications", join(homedir(), "Applications")];
    return [];
}

async function walk(platform: NodeJS.Platform, dir: string, depth: number, out: InstalledApp[]): Promise<void> {
    if (out.length >= MAX_APPS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (platform === "darwin") {
            if (entry.isDirectory() && entry.name.endsWith(".app")) out.push({ label: entry.name.slice(0, -4), path });
            continue;
        }
        if (entry.isDirectory()) {
            if (depth < MAX_DEPTH) await walk(platform, path, depth + 1, out);
            continue;
        }
        if (!/\.(lnk|url)$/i.test(entry.name)) continue;
        const label = entry.name.replace(/\.(lnk|url)$/i, "");
        // An uninstaller listed beside its program is not what anybody launches.
        if (/uninstall/i.test(label)) continue;
        out.push({ label, path });
    }
}

async function read(platform: NodeJS.Platform): Promise<Listing> {
    const out: InstalledApp[] = [];
    for (const root of roots(platform)) await walk(platform, root, 0, out);
    const stores = platform === "win32" ? await storeApps().catch(() => []) : [];
    // A game with a Start menu shortcut is listed once, by its shortcut.
    out.push(...stores);
    const seen = new Set<string>();
    const apps = out
        .filter((app) => {
            const key = app.label.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, MAX_APPS);
    const games = stores.flatMap((app) => (app.folder ? [{ name: app.label, folder: app.folder }] : []));
    return { apps, games };
}

/** The installed apps: the last listing straight away, read again behind it when stale. */
export function installedApps(platform: NodeJS.Platform = process.platform): readonly InstalledApp[] {
    if ((!cached || Date.now() - cached.at > FRESH_MS) && !reading) {
        started = true;
        reading = read(platform)
            .then((listing) => {
                cached = { at: Date.now(), ...listing };
                return listing;
            })
            .finally(() => {
                reading = null;
            });
    }
    return cached?.apps ?? [];
}

/** The installed apps once a listing has been read, for the conflict check. */
export async function installedAppsRead(platform: NodeJS.Platform = process.platform): Promise<readonly InstalledApp[]> {
    installedApps(platform);
    return (await reading)?.apps ?? cached?.apps ?? [];
}

/**
 * The installed store games and their folders from the last listing, for the
 * game watcher, which asks on every look: answered from memory, never read
 * again for it. The one exception is the first ask when the launcher never
 * listed anything (switched off, say), which starts one listing; after that it
 * is kept fresh by the launcher being opened.
 */
export function installedGames(platform: NodeJS.Platform = process.platform): readonly StoreGame[] {
    if (!started && platform === "win32") installedApps(platform);
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
            start(launch.path, [], launch.cwd);
            return true;
    }
}
