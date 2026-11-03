/**
 * What is waiting, on the app's own icon: the taskbar button on Windows, the
 * Dock on macOS, the launcher on Linux desktops that draw a count.
 *
 * The dashboard decides what to show - a count, a dot or nothing, from the
 * reader's own choice under Notifications - and hands it here, because in a
 * browser the same choice is drawn on the tab's icon and the desktop app has no
 * tab. Each system takes it its own way:
 *
 * - Windows draws a small picture over the corner of the taskbar button, so the
 *   dashboard sends that picture already drawn, in the same red as the tab's.
 * - macOS writes text on the Dock icon; a dot is a bullet.
 * - Linux takes a number, where the desktop shows one at all, and has no dot.
 */

import { z } from "zod";
import { app, nativeImage, type BrowserWindow } from "electron";

/** A PNG drawn by the page, small: an overlay is 16 pixels on screen. */
const OVERLAY = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_OVERLAY = 64 * 1024;

export const appBadgeSchema = z
    .object({
        /** What a count badge reads ("3", "9+"); null for a dot or nothing. */
        label: z.string().trim().max(4).nullable(),
        dot: z.boolean(),
        /** How many are waiting, for the systems that take a number. */
        count: z.number().int().min(0).max(100_000),
        /** The picture for the Windows taskbar, or null to take it off. */
        overlay: z.string().max(MAX_OVERLAY).regex(OVERLAY).nullable()
    })
    .strict();

export type AppBadge = z.infer<typeof appBadgeSchema>;

export function applyAppBadge(window: BrowserWindow | null, badge: AppBadge): void {
    const showing = badge.dot || badge.label !== null;
    if (process.platform === "win32") {
        if (!window || window.isDestroyed()) return;
        const image = showing && badge.overlay ? nativeImage.createFromDataURL(badge.overlay) : null;
        window.setOverlayIcon(image && !image.isEmpty() ? image : null, badge.label ?? "");
        return;
    }
    if (process.platform === "darwin") {
        app.dock?.setBadge(showing ? (badge.label ?? "•") : "");
        return;
    }
    app.setBadgeCount(showing && !badge.dot ? badge.count : 0);
}
