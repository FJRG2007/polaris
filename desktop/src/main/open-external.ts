/**
 * Handing a link to the system: the default browser for a web address, the mail
 * app for a mail link.
 *
 * Every outside link in the app ends here - a link the page opens in a new
 * window, a navigation away from the Polaris, the right-click menu, a deep link
 * for a different server. `shell.openExternal` rejects when Windows cannot
 * start the registered handler, and every caller used to drop that rejection
 * with `void`, so a link that failed to open did nothing at all and left no
 * trace. Now a failure is logged and, on Windows, retried through the shell's
 * own URL handler, which reads the same registration by a different route.
 */

import { BrowserWindow, app, clipboard, dialog, shell } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSafeExternalUrl } from "./navigation";

export interface OpenExternalDeps {
    readonly open: (url: string) => Promise<void>;
    /** A second route to the same handler, or null where there is none. */
    readonly fallback: ((url: string) => Promise<void>) | null;
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
    try {
        await deps.open(url);
        return true;
    } catch (error) {
        deps.log("Opening a link outside the app failed", error);
    }
    if (!deps.fallback) return false;
    try {
        await deps.fallback(url);
        return true;
    } catch (error) {
        deps.log("Opening a link through the shell's URL handler failed", error);
        return false;
    }
}

/**
 * `rundll32 url.dll,FileProtocolHandler <url>`: the shell's URL handler, run
 * with an argument array and no shell between, so nothing in the address is
 * read as a command. Only ever reached for a URL `isSafeExternalUrl` passed.
 */
function windowsFallback(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, (error) =>
            error ? reject(error) : resolve()
        );
    });
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
        detail: `Windows didn't open it in your browser. Copy it and paste it into your browser instead.

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
    open: (url) => shell.openExternal(url),
    fallback: process.platform === "win32" ? windowsFallback : null,
    log: writeLog
};

/** Open a link outside the app, for callers that do not wait on the outcome.
 *  When every route fails, the person is told and offered the address. */
export function openExternal(url: string): void {
    void openOutside(url, deps).then((opened) => {
        const address = outsideAddress(url);
        if (!opened && address) void sayFailed(address).catch(() => undefined);
    });
}
