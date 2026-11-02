/**
 * Opening with the computer.
 *
 * Windows and macOS keep this themselves. On Windows the entry has to name Squirrel's
 * launcher, since the app's own folder changes with every version. Linux has no system
 * call for it: a desktop file in the autostart folder is what every desktop reads.
 */

import { app } from "electron";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const NAME = "Polaris";

function linuxEntry(): string {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "polaris.desktop");
}

function setLinux(open: boolean): void {
    const entry = linuxEntry();
    if (!open) return rmSync(entry, { force: true });
    mkdirSync(dirname(entry), { recursive: true });
    const command = process.env.APPIMAGE ?? process.execPath;
    writeFileSync(
        entry,
        `[Desktop Entry]\nType=Application\nName=${NAME}\nExec="${command.replace(/(["\\$`])/g, "\\$1")}"\nX-GNOME-Autostart-enabled=true\n`
    );
}

function apply(open: boolean): void {
    if (process.platform === "linux") return setLinux(open);
    if (process.platform === "win32") {
        app.setLoginItemSettings({
            name: NAME,
            openAtLogin: open,
            path: join(dirname(process.execPath), "..", "Update.exe"),
            args: ["--processStart", basename(process.execPath)]
        });
        return;
    }
    app.setLoginItemSettings({ openAtLogin: open });
}

/**
 * Only an installed app: a development run has no business starting with the computer.
 * Answers whether it took. A preference that could not be written never stops the app
 * opening: an autostart folder can be read-only.
 */
export function setOpenAtLogin(open: boolean): boolean {
    if (!app.isPackaged) return true;
    try {
        apply(open);
        return true;
    } catch (caught) {
        console.error("polaris: opening with the computer could not be set:", caught);
        return false;
    }
}
