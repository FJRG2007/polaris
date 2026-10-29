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
