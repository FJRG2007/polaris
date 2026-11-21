/**
 * The app's icon in the season's dress: the window and taskbar button, the
 * notification-area icon and the Dock, the way Discord dresses its icon for a
 * holiday.
 *
 * The dashboard decides the season - on the reader's calendar, under the
 * operator's switch, exactly as it decides the rest of the decoration - and
 * sends the dressed mark already drawn; null puts back the icon the app ships
 * with. Nothing is installed or written to disk, so it needs no reinstall and
 * a new season is one message away.
 */

import { join } from "node:path";
import { z } from "zod";
import { app, nativeImage, type BrowserWindow, type NativeImage } from "electron";
import { setTrayImage } from "./tray";

/** A PNG drawn by the page: 256 pixels square. */
const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_PNG = 512 * 1024;

export const appIconSchema = z
    .object({ png: z.string().max(MAX_PNG).regex(PNG).nullable() })
    .strict();

export type AppIcon = z.infer<typeof appIconSchema>;

/** The icon the app ships with, the one a null puts back. */
function shipped(): NativeImage {
    const file = process.platform === "win32" ? "icon.ico" : "icon.png";
    return nativeImage.createFromPath(join(__dirname, "..", file));
}

/**
 * The square mark inside Apple's icon grid (an 824 body on a 1024 canvas), so
 * it is the size of its neighbours in the Dock - as `build/icons.cjs` draws the
 * shipped one.
 */
function onAppleGrid(image: NativeImage): NativeImage {
    const { width, height } = image.getSize();
    const side = Math.round((width * 1024) / 824);
    const inset = Math.round((side - width) / 2);
    const source = image.toBitmap();
    const target = Buffer.alloc(side * side * 4);
    for (let y = 0; y < height; y += 1) {
        source.copy(target, ((y + inset) * side + inset) * 4, y * width * 4, (y + 1) * width * 4);
    }
    return nativeImage.createFromBitmap(target, { width: side, height: side });
}

export function applyAppIcon(window: BrowserWindow | null, icon: AppIcon): void {
    const drawn = icon.png ? nativeImage.createFromDataURL(icon.png) : null;
    const image = drawn && !drawn.isEmpty() ? drawn : null;
    if (process.platform === "darwin") {
        // The Dock is the Mac's only icon here: the window carries none.
        if (image) app.dock?.setIcon(onAppleGrid(image));
        else app.dock?.setIcon(shipped());
        return;
    }
    if (window && !window.isDestroyed()) window.setIcon(image ?? shipped());
    setTrayImage(image);
}
