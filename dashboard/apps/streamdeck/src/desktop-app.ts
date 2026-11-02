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
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const CHECK_MS = 60_000;
const COMMAND_MS = 5_000;
const WINDOWS_KEY = "HKCU\\Software\\Classes\\polaris\\shell\\open\\command";
/** `polaris` among the bundle's link schemes: the same word is its executable's name. */
const MAC_LINK_SCHEME =
    /<key>CFBundleURLSchemes<\/key>\s*<array>(?:(?!<\/array>)[\s\S])*<string>polaris<\/string>/;

type Run = (file: string, args: readonly string[]) => Promise<string>;

const run: Run = (file, args) =>
    new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: COMMAND_MS, windowsHide: true }, (error, stdout) =>
            error ? reject(error) : resolve(stdout)
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

async function macAppHandlesLinks(
    read: (path: string) => Promise<string>,
    home: string
): Promise<boolean> {
    for (const folder of ["/Applications", join(home, "Applications")]) {
        const plist = await read(join(folder, "Polaris.app/Contents/Info.plist")).catch(() => "");
        if (MAC_LINK_SCHEME.test(plist)) return true;
    }
    return false;
}

/** The program a `reg query` of the link's command names, or null. */
function registeredProgram(output: string): string | null {
    return /REG_(?:EXPAND_)?SZ\s+"([^"]+)"/.exec(output)?.[1] ?? null;
}

/** The registry outlives an app removed by hand and an update's old folder, and
 *  Windows reports no failure when the program is gone, so it has to be there. */
async function windowsAppHandlesLinks(
    runCommand: Run,
    exists: (path: string) => Promise<boolean>
): Promise<boolean> {
    const output = await runCommand("reg", ["query", WINDOWS_KEY]).catch(() => "");
    const program = registeredProgram(output);
    return program ? exists(program) : false;
}

const fileExists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false
    );

/** Whether the app that answers `polaris://` is on this computer. */
export async function desktopAppInstalled(
    platform: NodeJS.Platform = process.platform,
    runCommand: Run = run,
    read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
    home = homedir(),
    exists: (path: string) => Promise<boolean> = fileExists
): Promise<boolean> {
    if (platform === "win32") return windowsAppHandlesLinks(runCommand, exists);
    return platform === "darwin" ? macAppHandlesLinks(read, home) : false;
}

async function openLink(link: string, platform: NodeJS.Platform, runCommand: Run): Promise<void> {
    if (platform === "win32") await runCommand("rundll32", ["url.dll,FileProtocolHandler", link]);
    else await runCommand("open", [link]);
}

/**
 * An opener that asks whether the app is there at most once a minute, and answers
 * whether the app took the page. False leaves it to the caller, which opens the
 * browser, so a press never ends with nothing on screen.
 */
export function desktopOpener(
    installed: () => Promise<boolean>,
    open: (link: string) => Promise<void>,
    now: () => number = Date.now
): (url: string) => Promise<boolean> {
    let known: { installed: boolean; at: number } | null = null;
    return async (url) => {
        const link = desktopLink(url);
        if (!link) return false;
        if (!known || now() - known.at > CHECK_MS)
            known = { installed: await installed(), at: now() };
        if (!known.installed) return false;
        return open(link).then(
            () => true,
            () => false
        );
    };
}

/** Open `url` in the desktop app, answering whether it did. */
export const openInDesktopApp = desktopOpener(
    () => desktopAppInstalled(),
    (link) => openLink(link, process.platform, run)
);
