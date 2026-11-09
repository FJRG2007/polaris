/**
 * The Windows installer's hooks.
 *
 * Squirrel runs the app itself with `--squirrel-install`, `--squirrel-updated`,
 * `--squirrel-uninstall` or `--squirrel-obsolete` while it installs, updates or
 * removes it. The app is expected to add or remove its shortcuts through
 * Squirrel's `Update.exe` and exit straight away; one that opened its window
 * instead would pop up in the middle of the installer.
 */

import { setOpenAtLogin } from "./login-item";
import { removeStoreEntries } from "./install-tool";
import { DEEP_LINK_SCHEME } from "@/shared/deep-link";
import { registerMailHandler, unregisterMailHandler } from "./mail-handler";
import { app } from "electron";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/** True when this launch was one of the installer's and the app is quitting. */
export function handledSquirrelEvent(): boolean {
    if (process.platform !== "win32") return false;
    const event = process.argv[1];
    if (!event?.startsWith("--squirrel-")) return false;

    const updater = resolve(dirname(process.execPath), "..", "Update.exe");
    const exe = basename(process.execPath);
    const updateThenQuit = (args: string[]) => {
        try {
            spawn(updater, args, { detached: true, windowsHide: true }).on("close", () => app.quit());
        } catch {
            app.quit();
        }
    };

    if (event === "--squirrel-install" || event === "--squirrel-updated") {
        app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
        void registerMailHandler(process.execPath).finally(() => updateThenQuit([`--createShortcut=${exe}`]));
        return true;
    }
    if (event === "--squirrel-uninstall") {
        setOpenAtLogin(false);
        app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME);
        // The browser's store entry goes with the app; the extension stays
        // installed in the browser, where it is the user's to remove.
        void Promise.allSettled([removeStoreEntries(), unregisterMailHandler()]).finally(() =>
            updateThenQuit([`--removeShortcut=${exe}`])
        );
        return true;
    }
    if (event === "--squirrel-obsolete") {
        app.quit();
        return true;
    }
    return false;
}
