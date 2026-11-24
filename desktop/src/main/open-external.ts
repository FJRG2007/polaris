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
 *   first because it is the one route whose outcome can be read: the started
 *   browser's exit code says whether the running copy took the link
 *   (BUG-0020). `shell.openExternal` resolves whether or not a browser showed
 *   anything, so when it only runs because the browser refused the link, the
 *   person is still shown the address.
 * - macOS and Linux: `shell.openExternal`, then `open` / `xdg-open`, whose exit
 *   code says whether the link was handed on.
 *
 * When every route fails, or the only one left cannot say it worked, the person
 * is told and offered the address, and the last link handed out can always be
 * copied from the tray. Every attempt is written to `links.log`.
 */

import { BrowserWindow, app, clipboard, dialog, shell } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeExternalUrl } from "./navigation";
import { rememberLink } from "./tray";
import * as browser from "./default-browser";

/** One way of handing a link to the system; rejects when it did not. */
export interface OutsideRoute {
    readonly name: string;
    readonly run: (url: string) => Promise<void>;
    /** Whether resolving means a program took the link. `shell.openExternal`
     *  resolves whether or not a browser opened it. */
    readonly confirms: boolean;
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
 *                   accepted it cannot say whether anything opened.
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
    for (const route of deps.routes) {
        try {
            await route.run(url);
            deps.log(`Opened ${logTarget(url)} through ${route.name}${route.confirms ? "" : " (not confirmed)"}`, null);
            return route.confirms || !refused ? "opened" : "unconfirmed";
        } catch (error) {
            if (!(error instanceof RouteUnavailable)) refused = true;
            deps.log(`Opening ${logTarget(url)} through ${route.name} failed`, error);
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
    launch: browser.launchDetached,
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
        return [direct, handOver];
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

/**
 * Said on screen when no route opened the link, so a click is never answered
 * with nothing: the address, and a way to take it to the browser by hand.
 */
async function sayFailed(url: string, outcome: Exclude<OpenOutcome, "opened">): Promise<void> {
    const program = url.startsWith("mailto:") ? "Your mail app" : "Your browser";
    const title = outcome === "failed" ? "Couldn't open the link" : "The link may not have opened";
    const said = outcome === "failed"
        ? `${program} didn't open it. Copy it and paste it there instead.`
        : `${program} didn't take it from Polaris, so Windows was asked instead. If nothing opened, copy it and paste it there.`;
    const options = {
        type: "warning" as const,
        title,
        message: title,
        detail: `${said}

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
    void openOutsideOutcome(url, deps).then((outcome) => {
        if (outcome !== "opened" && address) void sayFailed(address, outcome).catch(() => undefined);
    });
}
