/**
 * Opening a page in the user's browser, when there is one to open it in.
 *
 * Like Railway's and GitHub's CLIs, `plr login` falls back to showing a code by
 * itself when there is no browser here: over SSH, or on a Linux machine with no
 * display. The opener is spawned with an argument array and no shell, so an
 * address can never be read as a command.
 */

import type { Host } from "./paths.js";
import { spawn } from "node:child_process";

/** Whether a browser can plausibly be opened on this machine. */
export function canOpenBrowser(host: Host): boolean {
    if (host.env.SSH_CONNECTION || host.env.SSH_TTY) return false;
    if (host.platform === "win32" || host.platform === "darwin") return true;
    return Boolean(host.env.DISPLAY || host.env.WAYLAND_DISPLAY);
}

/** The program and arguments that open an address on this system. */
export function openerFor(host: Host, url: string): { command: string; args: string[] } {
    // rundll32 rather than `cmd /c start`: cmd would parse the & in a query
    // string as a command separator.
    if (host.platform === "win32")
        return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
    if (host.platform === "darwin") return { command: "open", args: [url] };
    return { command: "xdg-open", args: [url] };
}

/** Open it, and say whether the opener started. */
export function openBrowser(host: Host, url: string): Promise<boolean> {
    const { command, args } = openerFor(host, url);
    return new Promise((resolve) => {
        try {
            const child = spawn(command, args, {
                shell: false,
                detached: true,
                stdio: "ignore",
                windowsHide: true
            });
            child.on("error", () => resolve(false));
            child.on("spawn", () => {
                child.unref();
                resolve(true);
            });
        } catch {
            resolve(false);
        }
    });
}
