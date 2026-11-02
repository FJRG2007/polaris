/**
 * Opening a page in the Polaris desktop app when this computer has one, since that
 * is where somebody who installed it wants their Polaris.
 *
 * What is looked for is the app's `polaris://` link rather than the app itself: a
 * version too old to answer one has not registered it, so it counts as not there
 * and the page opens in the browser as before.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

const CHECK_MS = 60_000;
const COMMAND_MS = 5_000;
const WINDOWS_KEY = "HKCU\\Software\\Classes\\polaris\\shell\\open\\command";

type Run = (file: string, args: readonly string[]) => Promise<void>;

const run: Run = (file, args) =>
    new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: COMMAND_MS, windowsHide: true }, (error) =>
            error ? reject(error) : resolve()
        );
    });

/** The link that opens `url` in the app: its origin, and the page within it. */
export function desktopLink(url: string): string | null {
    try {
        const target = new URL(url);
        const server = encodeURIComponent(target.origin);
        const path = encodeURIComponent(`${target.pathname}${target.search}${target.hash}`);
        return `polaris://open?server=${server}&path=${path}`;
    } catch {
        return null;
    }
}

async function macAppHandlesLinks(read: (path: string) => Promise<string>, home: string): Promise<boolean> {
    for (const folder of ["/Applications", join(home, "Applications")]) {
        const plist = await read(join(folder, "Polaris.app/Contents/Info.plist")).catch(() => "");
        if (plist.includes("<string>polaris</string>")) return true;
    }
    return false;
}

/** Whether the app that answers `polaris://` is on this computer. */
export async function desktopAppInstalled(
    platform: NodeJS.Platform = process.platform,
    runCommand: Run = run,
    read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
    home = homedir()
): Promise<boolean> {
    if (platform === "win32") {
        return runCommand("reg", ["query", WINDOWS_KEY]).then(
            () => true,
            () => false
        );
    }
    return platform === "darwin" ? macAppHandlesLinks(read, home) : false;
}

async function openLink(link: string, platform: NodeJS.Platform, runCommand: Run): Promise<void> {
    if (platform === "win32") await runCommand("rundll32", ["url.dll,FileProtocolHandler", link]);
    else await runCommand("open", [link]);
}

let known: { installed: boolean; at: number } | null = null;

/**
 * Open `url` in the app, answering whether it did. False leaves it to the caller,
 * which opens the browser, so a press never ends with nothing on screen.
 */
export async function openInDesktopApp(url: string): Promise<boolean> {
    const link = desktopLink(url);
    if (!link) return false;
    if (!known || Date.now() - known.at > CHECK_MS) {
        known = { installed: await desktopAppInstalled(), at: Date.now() };
    }
    if (!known.installed) return false;
    return openLink(link, process.platform, run).then(
        () => true,
        () => false
    );
}
