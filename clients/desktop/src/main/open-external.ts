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
 *   (`default-browser.ts`); then the desktop's own Explorer, which starts the
 *   browser outside Polaris's process tree (`handToShell`); then
 *   `shell.openExternal`. The direct start comes first because it is the one
 *   route whose outcome can be read: the started browser's exit code says
 *   whether the running copy took the link. When it did not - a browser
 *   started by Polaris that turns the link down while one is already open
 *   (BUG-0020) - Explorer starts it instead, as it does for a link clicked
 *   anywhere else in Windows. Explorer is tried only then: it reports a
 *   failure with the system's own error box, so after a browser that could
 *   not be started at all (`spawn EPERM`, a Store browser with no command) it
 *   is skipped (BUG-0071), and `shell.openExternal` is asked instead - Electron
 *   calls `ShellExecuteEx` with `SEE_MASK_FLAG_NO_UI` there
 *   (`shell/common/platform_util_win.cc`), which never shows one.
 * - macOS and Linux: `shell.openExternal`, then `open` / `xdg-open`, whose exit
 *   code says whether the link was handed on.
 *
 * Only when every route refused the link is the person told, inside the
 * window and without stopping them: the address and Copy link. A route that
 * accepted the link and has no refusal to read is taken at its word - the
 * system's own alert box is never shown for a link. The last link handed out
 * can always be copied from the tray. Every attempt is written to `links.log`.
 */

import { BrowserWindow, app, shell } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeExternalUrl } from "./navigation";
import { CHANNELS } from "@/shared/bridge";
import { rememberLink } from "./tray";
import * as browser from "./default-browser";

/** One way of handing a link to the system; rejects when it did not. */
export interface OutsideRoute {
    readonly name: string;
    readonly run: (url: string) => Promise<void>;
    /** Whether resolving means a program took the link. `shell.openExternal`
     *  resolves whether or not a browser opened it. */
    readonly confirms: boolean;
    /** When set, the route is tried only if the route before it failed with an
     *  error this accepts; otherwise it is skipped, which is not a refusal. */
    readonly after?: (previous: unknown) => boolean;
}

/** Thrown by a route that does not apply here (a Store browser registers no
 *  command), which is not a refusal of the link. */
export class RouteUnavailable extends Error {}

export interface OpenExternalDeps {
    /** Tried in order; the first that resolves wins. */
    readonly routes: readonly OutsideRoute[];
    /** Every attempt, failed or not; `error` is null for one that worked. */
    readonly log: (message: string, error: unknown) => void;
}

/**
 * - `opened`      - a route that can tell took the link, or the only route
 *                   there was accepted it.
 * - `unconfirmed` - an earlier route refused the link, and the one that
 *                   accepted it cannot say whether anything opened. Not said
 *                   on screen: the route raised no refusal to show.
 * - `failed`      - not a link that may leave the app, or every route failed.
 */
export type OpenOutcome = "opened" | "unconfirmed" | "failed";

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
    return (await openOutsideOutcome(raw, deps)) !== "failed";
}

/** The link's scheme and host, for the log: never the whole address, which can
 *  carry a sign-in token or a tracking id. */
function logTarget(url: string): string {
    const target = new URL(url);
    return target.protocol === "mailto:" ? "a mail link" : `${target.protocol}//${target.host}`;
}

/** `openOutside`, with whether the outcome could be seen. */
export async function openOutsideOutcome(raw: string, deps: OpenExternalDeps): Promise<OpenOutcome> {
    const url = outsideAddress(raw);
    if (!url) return "failed";
    let refused = false;
    let previous: unknown = null;
    for (const route of deps.routes) {
        if (route.after && !route.after(previous)) {
            deps.log(`Skipped ${route.name} for ${logTarget(url)}: the route before it did not start a browser`, null);
            continue;
        }
        try {
            await route.run(url);
            deps.log(`Opened ${logTarget(url)} through ${route.name}${route.confirms ? "" : " (not confirmed)"}`, null);
            return route.confirms || !refused ? "opened" : "unconfirmed";
        } catch (error) {
            if (!(error instanceof RouteUnavailable) && !(error instanceof browser.ShellUnavailable)) refused = true;
            deps.log(`Opening ${logTarget(url)} through ${route.name} failed`, error);
            previous = error;
        }
    }
    return "failed";
}

/**
 * What the routes reach the system through. One object, so the Electron
 * harness (`test/electron/links`) can swap each part for a recorder and never
 * start a real browser.
 */
export const outsideSystem = {
    open: (url: string): Promise<void> => shell.openExternal(url),
    readRegistry: browser.readRegistry,
    launch: (file: string, args: readonly string[]): Promise<void> => browser.launchDetached(file, args),
    shell: (url: string): Promise<void> => browser.handToShell(url),
    opener: browser.runOpener
};

/** The routes for a platform, in the order they are tried. */
export function routesFor(platform: NodeJS.Platform, system: typeof outsideSystem = outsideSystem): OutsideRoute[] {
    const handOver: OutsideRoute = { name: "the system's URL handler", run: (url) => system.open(url), confirms: false };
    if (platform === "win32") {
        const direct: OutsideRoute = {
            name: "the default browser's registered command",
            run: async (url) => {
                const launch = await browser.registeredLaunch(url, system.readRegistry);
                if (!launch) throw new RouteUnavailable("No registered command for this kind of link");
                await system.launch(launch.file, launch.args);
            },
            confirms: true
        };
        // Only after a browser that started and turned the link down: Explorer
        // shows the system's error box for a browser it cannot start (BUG-0071).
        const desktop: OutsideRoute = {
            name: "the Windows shell (Explorer)",
            run: (url) => system.shell(url),
            confirms: false,
            after: (previous) => previous instanceof browser.BrowserRefused
        };
        return [direct, desktop, handOver];
    }
    const opener = platform === "darwin" ? "open" : "xdg-open";
    return [handOver, { name: opener, run: (url) => system.opener(opener, url), confirms: true }];
}

/** Where every hand-over is written, beside the app's other logs, so it
 *  survives a restart; kept to one file and one previous one. The folder is
 *  made here: Electron names it but does not create it, and appending into a
 *  folder that is not there throws - which kept this log from ever being
 *  written from 0.1.58 to 0.1.90 (BUG-0020). */
function writeLog(message: string, error: unknown): void {
    if (error !== null) console.error(`[polaris] ${message}:`, error);
    try {
        const folder = app.getPath("logs");
        mkdirSync(folder, { recursive: true });
        const file = join(folder, "links.log");
        try {
            if (statSync(file).size > 256 * 1024) renameSync(file, `${file}.old`);
        } catch {
            // No file yet.
        }
        const detail = error === null ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
        appendFileSync(file, `${new Date().toISOString()} ${message}${detail}
`);
    } catch {
        // A log that cannot be written must never stop the link.
    }
}

/** What the in-window notice is told when no route opened a link
 *  (`preload/link-notice.ts`). */
export interface LinkNotice {
    readonly url: string;
    readonly title: string;
    readonly body: string;
}

/** The words for a link no route opened. */
export function linkNotice(url: string): LinkNotice {
    const program = url.startsWith("mailto:") ? "Your mail app" : "Your browser";
    return { url, title: "Couldn't open the link", body: `${program} didn't open it. Copy it and paste it there.` };
}

/**
 * Said inside the window when no route opened the link, so a click is never
 * answered with nothing - and never with a system alert box that stops the
 * person until it is dismissed. Sent to the focused window, else the first
 * shown one; the tray's "Copy last link opened" covers a click with no window
 * left to tell.
 */
function sayFailed(url: string): void {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((each) => !each.isDestroyed() && each.isVisible());
    if (!window || window.isDestroyed()) return;
    window.webContents.send(CHANNELS.linkNotice, linkNotice(url));
}

const deps: OpenExternalDeps = {
    routes: routesFor(process.platform),
    log: writeLog
};

/** Open a link outside the app, for callers that do not wait on the outcome.
 *  When every route refused it, the person is told and offered the address. */
export function openExternal(url: string): void {
    const address = outsideAddress(url);
    if (address) rememberLink(address);
    void openOutsideOutcome(url, deps).then((outcome) => {
        if (outcome === "failed" && address) sayFailed(address);
    });
}
