/**
 * The app's shortcuts in the season's dress, on Windows.
 *
 * The window's own icon (`setIcon`) is what its title bar and Alt+Tab show, but
 * the taskbar draws the button of a window that carries an app id with the icon
 * of the shortcut carrying that id - the Start menu's, or the pinned one - so a
 * dressed window still sat behind a plain button. Chrome keeps a profile's
 * badged icon on the taskbar the same way, by rewriting the icon of that
 * profile's shortcuts (`chrome/browser/profiles/profile_shortcut_manager_win.cc`).
 *
 * Only the icon of a shortcut that starts this app is touched, and it goes
 * back to the app's own once the season ends. Squirrel writes its shortcuts
 * again on every update; the next icon settled after a start dresses them again.
 */

import { app, shell } from "electron";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Where the app's shortcuts live: the Start menu (and one folder down, where
 *  Squirrel puts them under the company), the desktop and the taskbar's pins. */
export function shortcutFolders(appData: string, desktop: string): string[] {
    const programs = join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
    const pinned = join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
    return [programs, desktop, pinned];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether a shortcut's target is this app: the Squirrel stub or the executable. Pure. */
export function startsApp(target: string, starters: readonly string[]): boolean {
    return target !== "" && starters.some((starter) => same(target, starter));
}

/**
 * The icon a shortcut should carry: the dressed .ico in a season, else the
 * app's own (the starter's first icon). Null where it already carries it. Pure.
 */
export function iconChange(
    current: { readonly icon?: string; readonly iconIndex?: number; },
    dressed: string | null,
    starter: string
): { readonly icon: string; readonly iconIndex: number; } | null {
    const wanted = dressed ?? starter;
    const icon = current.icon ?? "";
    // A shortcut without an icon of its own shows its target's, which is the plain one.
    if (!dressed && (icon === "" || same(icon, starter)) && (current.iconIndex ?? 0) === 0) return null;
    if (same(icon, wanted) && (current.iconIndex ?? 0) === 0) return null;
    return { icon: wanted, iconIndex: 0 };
}

function shortcutsIn(folder: string, depth: number): string[] {
    let entries: Dirent[];
    try {
        entries = readdirSync(folder, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.flatMap((entry) => {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) return depth > 0 ? shortcutsIn(path, depth - 1) : [];
        return entry.isFile() && entry.name.toLowerCase().endsWith(".lnk") ? [path] : [];
    });
}

/**
 * Point every shortcut that starts this app at `dressed` (the season's .ico),
 * or back at the app's own icon for null. Windows only, installed only; any
 * shortcut that cannot be read or written is left as it is.
 */
export function syncShortcutIcons(dressed: string | null): void {
    if (process.platform !== "win32" || !app.isPackaged) return;
    try {
        // A Squirrel install is started from the stub beside Update.exe.
        const stub = join(dirname(dirname(process.execPath)), basename(process.execPath));
        const starter = existsSync(stub) ? stub : process.execPath;
        const starters = [stub, process.execPath];
        for (const folder of shortcutFolders(app.getPath("appData"), app.getPath("desktop"))) {
            for (const file of shortcutsIn(folder, 1)) {
                try {
                    const link = shell.readShortcutLink(file);
                    if (!startsApp(link.target, starters)) continue;
                    const change = iconChange(link, dressed, starter);
                    if (change) shell.writeShortcutLink(file, "update", { target: link.target, ...change });
                } catch {
                    // Not a shortcut this app can read or write.
                }
            }
        }
    } catch {
        // The window's own icon is dressed either way.
    }
}
