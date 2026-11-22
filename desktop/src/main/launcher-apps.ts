/**
 * The programs installed on this computer, for the launcher to open: the Start
 * menu's shortcuts on Windows and the `.app` bundles in the Applications
 * folders on macOS. Read from the file system when the launcher first opens
 * and again on an open after `FRESH_MS`, never on a timer, and opened through
 * the shell (`shell.openPath`), the way a double-click would - nothing is run
 * with arguments the launcher made up.
 *
 * Linux is not indexed: a `.desktop` entry handed to the shell opens in a text
 * editor on most desktops, and running its `Exec` line safely means a parser
 * for the Desktop Entry spec's field codes, which this does not carry yet.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";

export interface InstalledApp {
    readonly label: string;
    readonly path: string;
}

/** How long a listing is trusted before the next open reads it again. */
const FRESH_MS = 10 * 60_000;
/** The most apps kept, so an odd machine cannot fill memory with shortcuts. */
const MAX_APPS = 2000;
const MAX_DEPTH = 3;

let cached: { readonly at: number; readonly apps: readonly InstalledApp[]; } | null = null;
let reading: Promise<readonly InstalledApp[]> | null = null;

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

async function read(platform: NodeJS.Platform): Promise<readonly InstalledApp[]> {
    const out: InstalledApp[] = [];
    for (const root of roots(platform)) await walk(platform, root, 0, out);
    const seen = new Set<string>();
    return out.filter((app) => {
        const key = app.label.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** The installed apps: the last listing straight away, read again behind it when stale. */
export function installedApps(platform: NodeJS.Platform = process.platform): readonly InstalledApp[] {
    if ((!cached || Date.now() - cached.at > FRESH_MS) && !reading) {
        reading = read(platform)
            .then((apps) => {
                cached = { at: Date.now(), apps };
                return apps;
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
    return reading ?? cached?.apps ?? [];
}

/** Whether `path` is one of the apps listed, so only those can be opened. */
export function isListedApp(path: string): boolean {
    return cached?.apps.some((app) => app.path === path) ?? false;
}
