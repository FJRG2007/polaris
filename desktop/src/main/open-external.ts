/**
 * Handing a link to the system: the default browser for a web address, the mail
 * app for a mail link.
 *
 * Every outside link in the app ends here - a link the page opens in a new
 * window, a navigation away from the Polaris, the right-click menu, a deep link
 * for a different server. Each platform has an ordered list of routes and the
 * first that works wins:
 *
 * - Windows: the default browser's registered command, started directly
 *   (`default-browser.ts`), then `shell.openExternal`. The direct start comes
 *   first because it is the one route whose failure can be seen: Windows' own
 *   hand-over was found resolving with no browser appearing (BUG-0020), and
 *   `rundll32 url.dll` reports success whether or not anything opened, so it is
 *   no longer used.
 * - macOS and Linux: `shell.openExternal`, then `open` / `xdg-open`, whose exit
 *   code says whether the link was handed on.
 *
 * When every route fails the person is told and offered the address, and the
 * last link handed out can always be copied from the tray.
 */

import { BrowserWindow, app, clipboard, dialog, shell } from "electron";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeExternalUrl } from "./navigation";
import { rememberLink } from "./tray";
import * as browser from "./default-browser";

/** One way of handing a link to the system; rejects when it did not. */
export interface OutsideRoute {
    readonly name: string;
    readonly run: (url: string) => Promise<void>;
}

export interface OpenExternalDeps {
    /** Tried in order; the first that resolves wins. */
    readonly routes: readonly OutsideRoute[];
    readonly log: (message: string, error: unknown) => void;
}

/**
 * The address as the system is handed it: parsed and written back out, so a
 * link with stray spaces or unescaped characters reaches the browser in the
 * one form every route accepts. Never shortened - a tracking link of several
 * thousand characters goes out whole. Null for anything but http, https and
 * mailto.
 */
export function outsideAddress(url: string): string | null {
    if (!isSafeExternalUrl(url.trim())) return null;
    return new URL(url.trim()).href;
}

/**
 * Open `url` outside the app. Resolves true when a route accepted it; false
 * for a URL that is not http, https or mailto, and when every route failed.
 */
export async function openOutside(raw: string, deps: OpenExternalDeps): Promise<boolean> {
    const url = outsideAddress(raw);
    if (!url) return false;
    for (const route of deps.routes) {
        try {
            await route.run(url);
            return true;
        } catch (error) {
            deps.log(`Opening a link through ${route.name} failed`, error);
        }
    }
    return false;
}

/**
 * What the routes reach the system through. One object, so the Electron
 * harness (`test/electron/links`) can swap each part for a recorder and never
 * start a real browser.
 */
export const outsideSystem = {
    open: (url: string): Promise<void> => shell.openExternal(url),
    readRegistry: browser.readRegistry,
    launch: browser.launchDetached,
    opener: browser.runOpener
};

/** The routes for a platform, in the order they are tried. */
export function routesFor(platform: NodeJS.Platform, system: typeof outsideSystem = outsideSystem): OutsideRoute[] {
    const handOver: OutsideRoute = { name: "the system's URL handler", run: (url) => system.open(url) };
    if (platform === "win32") {
        const direct: OutsideRoute = {
            name: "the default browser's registered command",
            run: async (url) => {
                const launch = await browser.registeredLaunch(url, system.readRegistry);
                if (!launch) throw new Error("No registered command for this kind of link");
                await system.launch(launch.file, launch.args);
            }
        };
        return [direct, handOver];
    }
    const opener = platform === "darwin" ? "open" : "xdg-open";
    return [handOver, { name: opener, run: (url) => system.opener(opener, url) }];
}

/** Where a failed hand-over is written, beside the app's other logs, so it
 *  survives a restart; kept to one file and one previous one. */
function writeLog(message: string, error: unknown): void {
    console.error(`[polaris] ${message}:`, error);
    try {
        const file = join(app.getPath("logs"), "links.log");
        try {
            if (statSync(file).size > 256 * 1024) renameSync(file, `${file}.old`);
        } catch {
            // No file yet.
        }
        const detail = error instanceof Error ? error.message : String(error);
        appendFileSync(file, `${new Date().toISOString()} ${message}: ${detail}
`);
    } catch {
        // A log that cannot be written must never stop the link.
    }
}

/**
 * Said on screen when no route opened the link, so a click is never answered
 * with nothing: the address, and a way to take it to the browser by hand.
 */
async function sayFailed(url: string): Promise<void> {
    const options = {
        type: "warning" as const,
        title: "Couldn't open the link",
        message: "Couldn't open the link",
        detail: `${url.startsWith("mailto:") ? "Your mail app" : "Your browser"} didn't open it. Copy it and paste it there instead.

${url}`,
        buttons: ["Copy link", "Close"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    };
    const parent = BrowserWindow.getFocusedWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response === 0) clipboard.writeText(url);
}

const deps: OpenExternalDeps = {
    routes: routesFor(process.platform),
    log: writeLog
};

/** Open a link outside the app, for callers that do not wait on the outcome.
 *  When every route fails, the person is told and offered the address. */
export function openExternal(url: string): void {
    const address = outsideAddress(url);
    if (address) rememberLink(address);
    void openOutside(url, deps).then((opened) => {
        if (!opened && address) void sayFailed(address).catch(() => undefined);
    });
}
