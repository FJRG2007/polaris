/**
 * Strokes the call draws on this computer's shared screen, shown on the
 * display being shared.
 *
 * The dashboard hands over every stroke it believed (`drawOnShare`); the first
 * one opens a see-through window over the display the share came from (see
 * `openOverlayWindow`), and the window draws and fades them. Only a whole
 * screen can be drawn on this way: a window moves, and its place on the
 * display is not something a share says. Closed when the share ends, and on
 * its own once nothing has been drawn for a while.
 */

import { CHANNELS } from "@/shared/bridge";
import { sharedSource } from "./screen-share";
import { openOverlayWindow } from "./windows";
import type { StrokeInput } from "@/shared/annotate";
import { screen, type BrowserWindow, type Display } from "electron";

/** How long the window stays after the last stroke, with nothing to draw. */
const IDLE_MS = 30_000;
/** Strokes held while the window loads. */
const QUEUE_MAX = 256;

interface Overlay {
    readonly window: BrowserWindow;
    readonly displayId: string;
    ready: boolean;
    readonly queued: StrokeInput[];
}

let overlay: Overlay | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;

/** The display the current share is of, or null for a window or no share. */
function sharedDisplay(): Display | null {
    const source = sharedSource();
    if (!source?.id.startsWith("screen:")) return null;
    const displays = screen.getAllDisplays();
    // Some systems leave the display id empty on a screen source; with one
    // display there is no question which it is.
    const named = displays.find((display) => String(display.id) === source.displayId);
    return named ?? (displays.length === 1 ? (displays[0] ?? null) : null);
}

function open(display: Display): Overlay {
    const window = openOverlayWindow(display.bounds);
    const opened: Overlay = { window, displayId: String(display.id), ready: false, queued: [] };
    window.webContents.once("did-finish-load", () => {
        opened.ready = true;
        window.showInactive();
        for (const stroke of opened.queued.splice(0)) window.webContents.send(CHANNELS.overlayStroke, stroke);
    });
    window.once("closed", () => {
        if (overlay === opened) overlay = null;
    });
    return opened;
}

/** Show one stroke on the shared display. False when there is none to show it on. */
export function drawOnShare(stroke: StrokeInput): boolean {
    const display = sharedDisplay();
    if (!display) return false;
    // A share moved to another display starts over there.
    if (overlay && (overlay.window.isDestroyed() || overlay.displayId !== String(display.id))) stopDrawing();
    overlay ??= open(display);
    if (overlay.ready) overlay.window.webContents.send(CHANNELS.overlayStroke, stroke);
    else if (overlay.queued.length < QUEUE_MAX) overlay.queued.push(stroke);
    if (idle) clearTimeout(idle);
    idle = setTimeout(stopDrawing, IDLE_MS);
    return true;
}

export function stopDrawing(): void {
    if (idle) clearTimeout(idle);
    idle = null;
    const current = overlay;
    overlay = null;
    if (current && !current.window.isDestroyed()) current.window.destroy();
}
