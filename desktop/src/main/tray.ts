/**
 * The icon in the notification area, on Windows and Linux.
 *
 * The window draws no menu bar there, so what that menu held that is the app's
 * own - the servers, the saved API key, an update waiting - is here, the way
 * Discord and Slack keep theirs. macOS keeps all of it in its menu bar, which is
 * outside the window and where it belongs on a Mac.
 */

import { join } from "node:path";
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";

let tray: Tray | null = null;
/** The dressed image asked for, kept for a tray put up after the ask. */
let wanted: Electron.NativeImage | null = null;

/** The tray icon in the season's dress, or the shipped one for null. A no-op
 *  until the tray is up, and on macOS, which has none. */
export function setTrayImage(image: Electron.NativeImage | null): void {
    wanted = image;
    if (!tray || tray.isDestroyed()) return;
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
    if (!tray) {
        // The .ico on Windows, which carries every size the notification area
        // asks for at each display scale; the PNG elsewhere.
        const file = process.platform === "win32" ? "icon.ico" : "icon.png";
        const image = nativeImage.createFromPath(join(__dirname, "..", file));
        tray = new Tray(process.platform === "win32" ? image : image.resize({ width: 22, height: 22 }));
        tray.setToolTip("Polaris");
        tray.on("click", show);
        if (wanted) setTrayImage(wanted);
    }
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "Open Polaris", click: show },
            { type: "separator" },
            ...items,
            { type: "separator" },
            { label: "Quit Polaris", role: "quit" }
        ])
    );
}
