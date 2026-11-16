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

import { shell } from "electron";
import { execFile } from "node:child_process";
import { isSafeExternalUrl } from "./navigation";

export interface OpenExternalDeps {
    readonly open: (url: string) => Promise<void>;
    /** A second route to the same handler, or null where there is none. */
    readonly fallback: ((url: string) => Promise<void>) | null;
    readonly log: (message: string, error: unknown) => void;
}

/**
 * Open `url` outside the app. Resolves true when a route accepted it; false
 * for a URL that is not http, https or mailto, and when every route failed.
 */
export async function openOutside(url: string, deps: OpenExternalDeps): Promise<boolean> {
    if (!isSafeExternalUrl(url)) return false;
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

const deps: OpenExternalDeps = {
    open: (url) => shell.openExternal(url),
    fallback: process.platform === "win32" ? windowsFallback : null,
    log: (message, error) => console.error(`[polaris] ${message}:`, error)
};

/** Open a link outside the app, for callers that do not wait on the outcome. */
export function openExternal(url: string): void {
    void openOutside(url, deps);
}
