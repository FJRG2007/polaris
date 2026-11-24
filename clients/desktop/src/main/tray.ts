/**
 * The icon in the notification area, on Windows and Linux.
 *
 * The window draws no menu bar there, so what that menu held that is the app's
 * own - the servers, the saved API key, an update waiting - is here, the way
 * Discord and Slack keep theirs. macOS keeps all of it in its menu bar, which is
 * outside the window and where it belongs on a Mac.
 */

import { join } from "node:path";
import { Menu, Tray, clipboard, nativeImage, type MenuItemConstructorOptions } from "electron";

let tray: Tray | null = null;
/** The dressed image asked for, kept for a tray put up after the ask. */
let wanted: Electron.NativeImage | null = null;
/** The same as an .ico on Windows, when one could be written. */
let wantedFile: string | null = null;
/** What the menu was last put up with, so it can be put up again. */
let held: { items: readonly MenuItemConstructorOptions[]; show: () => void } | null = null;
/** The last link handed to the browser, for "Copy last link opened". */
let lastLink: string | null = null;
/** The add-ons whose device is plugged in now, each a way to its page. */
let addons: { items: readonly { id: string; name: string; }[]; open: (id: string) => void } = { items: [], open: () => undefined };

/**
 * Remember the last link sent to the browser. A link that the system took but
 * no browser showed leaves no dialog behind, so its address stays one click
 * away here (BUG-0020).
 */
export function rememberLink(url: string): void {
    lastLink = url;
    if (held) installTray(held.items, held.show);
}

/**
 * The add-ons to offer "Configure <name>" for: those whose device is plugged in
 * now (`addons/ways-in.ts`). Nothing is listed while none is.
 */
export function setTrayAddons(items: readonly { id: string; name: string; }[], open: (id: string) => void): void {
    addons = { items, open };
    if (held) installTray(held.items, held.show);
}

/** The tray icon in the season's dress, or the shipped one for null. A no-op
 *  until the tray is up, and on macOS, which has none. On Windows `icoFile` is the
 *  same picture as an .ico, which carries a size for every display scale the
 *  way the shipped one does. */
export function setTrayImage(image: Electron.NativeImage | null, icoFile: string | null = null): void {
    wanted = image;
    wantedFile = icoFile;
    if (!tray || tray.isDestroyed()) return;
    const ico = image && icoFile && process.platform === "win32" ? nativeImage.createFromPath(icoFile) : null;
    if (ico && !ico.isEmpty()) {
        tray.setImage(ico);
        return;
    }
    if (image) {
        // 32 on Windows, where the notification area scales it to the display.
        const side = process.platform === "win32" ? 32 : 22;
        tray.setImage(image.resize({ width: side, height: side }));
        return;
    }
    const file = process.platform === "win32" ? "icon.ico" : "icon.png";
    const shipped = nativeImage.createFromPath(join(__dirname, "..", file));
    tray.setImage(process.platform === "win32" ? shipped : shipped.resize({ width: 22, height: 22 }));
}

/** Put the icon up, or refresh what it offers. Clicking it brings Polaris forward. */
export function installTray(items: readonly MenuItemConstructorOptions[], show: () => void): void {
    if (process.platform === "darwin") return;
    held = { items, show };
    if (!tray) {
        // The .ico on Windows, which carries every size the notification area
        // asks for at each display scale; the PNG elsewhere.
        const file = process.platform === "win32" ? "icon.ico" : "icon.png";
        const image = nativeImage.createFromPath(join(__dirname, "..", file));
        tray = new Tray(process.platform === "win32" ? image : image.resize({ width: 22, height: 22 }));
        tray.setToolTip("Polaris");
        tray.on("click", show);
        if (wanted) setTrayImage(wanted, wantedFile);
    }
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "Open Polaris", click: show },
            { type: "separator" },
            ...items,
            { type: "separator" },
            ...(addons.items.length > 0
                ? [...addons.items.map((addon): MenuItemConstructorOptions => ({ label: `Configure ${addon.name}`, click: () => addons.open(addon.id) })), { type: "separator" as const }]
                : []),
            {
                label: "Copy last link opened",
                enabled: lastLink !== null,
                click: () => {
                    if (lastLink) clipboard.writeText(lastLink);
                }
            },
            { type: "separator" },
            { label: "Quit Polaris", role: "quit" }
        ])
    );
}
