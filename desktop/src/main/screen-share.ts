/**
 * Sharing a screen or a window, for a call's screen share and a clip recording.
 *
 * Electron has no picker of its own for `getDisplayMedia`. The dashboard draws
 * one in its own design: it asks this app for the screens and windows with a
 * picture of each (`shareSources`), the person picks one there, and the pick is
 * handed back (`chooseShare`) just before the page calls `getDisplayMedia`,
 * which then shares exactly that, with this computer's sound on Windows when
 * the box was ticked.
 *
 * Where macOS offers its system picker, that is what is shown and the page
 * gets no list. A page older than the picker, or a request with no pick in
 * front of it, gets the native dialog that came before; on Linux under Wayland
 * the desktop's own portal has already asked, and hands back the one source
 * that was picked. Only the configured Polaris may ask, and dismissing any of
 * them shares nothing.
 */

import { allowPermission } from "./permissions";
import type { ShareSource, ShareSources } from "@/shared/bridge";
import {
    BrowserWindow,
    desktopCapturer,
    dialog,
    session,
    webContents,
    type DesktopCapturerSource,
    type Streams,
    type WebFrameMain
} from "electron";

/** How many sources the dialog offers: every screen, then windows up to this. */
const MAX_CHOICES = 12;
const MAX_LABEL = 60;
/** How many windows the page's picker lists. */
const MAX_WINDOWS = 40;
const THUMBNAIL = { width: 320, height: 180 };
/** How long a pick waits for the `getDisplayMedia` it was made for. */
const PICK_MS = 15_000;

/** The source ids `desktopCapturer` hands out: `screen:0:0`, `window:1234:0`. */
export const SOURCE_ID = /^(screen|window):[\w-]+:\d+$/;

/** Sound can be captured with a share only on Windows (system loopback). */
const SOUND = process.platform === "win32";

let pick: { readonly id: string; readonly sound: boolean; readonly until: number; } | null = null;

/** What is being shared now, for drawing on it: the source and its display. */
let shared: { readonly id: string; readonly displayId: string; } | null = null;

export function sharedSource(): { readonly id: string; readonly displayId: string; } | null {
    return shared;
}

/** The share the page was drawing on ended. */
export function endShare(): void {
    shared = null;
}

function label(source: DesktopCapturerSource): string {
    const name = source.name.trim() || (source.id.startsWith("screen:") ? "Screen" : "Window");
    return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 3)}...` : name;
}

/** The screens and windows, each with a small picture, for the page's picker.
 *  Null where the system's own picker is the one to use.
 *
 *  Listing alone costs most of a second on Windows (measured: 0.6-1.0 s for
 *  16 sources, 1.1-1.7 s with pictures and icons), so the picker opens at once
 *  and asks twice: names first (`thumbnails: false`), pictures right after. */
export async function listShareSources({ thumbnails = true }: { readonly thumbnails?: boolean; } = {}): Promise<ShareSources | null> {
    if (process.platform === "darwin") return null;
    const sources = await desktopCapturer.getSources(
        thumbnails
            ? { types: ["screen", "window"], thumbnailSize: THUMBNAIL, fetchWindowIcons: true }
            : { types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } }
    );
    const screens = sources.filter((source) => source.id.startsWith("screen:"));
    const windows = sources.filter((source) => !source.id.startsWith("screen:")).slice(0, MAX_WINDOWS);
    const shape = (source: DesktopCapturerSource): ShareSource => ({
        id: source.id,
        name: source.name.trim().slice(0, 200),
        kind: source.id.startsWith("screen:") ? "screen" : "window",
        thumbnail: source.thumbnail.isEmpty() ? null : `data:image/jpeg;base64,${source.thumbnail.toJPEG(70).toString("base64")}`,
        icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.resize({ width: 32 }).toDataURL() : null
    });
    return { sources: [...screens, ...windows].map(shape), sound: SOUND };
}

/** Remember what the page's picker chose, for the request that follows it. */
export function chooseShare(id: string, sound: boolean, now = Date.now()): void {
    pick = { id, sound: sound && SOUND, until: now + PICK_MS };
}

/** The source the person picked, or null when they picked none. */
async function choose(frame: WebFrameMain | null): Promise<{ source: DesktopCapturerSource; sound: boolean; } | null> {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    if (sources.length === 0) return null;

    // A pick stays until a share starts from it or it runs out, so the
    // page's retry without sound, after one with sound failed, shares the
    // same source instead of opening the old dialog.
    const picked = pick && pick.until > Date.now() ? pick : null;
    if (picked) {
        const source = sources.find((candidate) => candidate.id === picked.id);
        // A window closed between the pick and the request: nothing is shared
        // rather than something else.
        return source ? { source, sound: picked.sound } : null;
    }

    if (process.platform === "linux" && sources.length === 1) return sources[0] ? { source: sources[0], sound: false } : null;

    const screens = sources.filter((source) => source.id.startsWith("screen:"));
    const windows = sources.filter((source) => !source.id.startsWith("screen:"));
    const offered = [...screens, ...windows].slice(0, Math.max(MAX_CHOICES, screens.length));
    const contents = frame ? webContents.fromFrame(frame) : undefined;
    const parent = contents ? BrowserWindow.fromWebContents(contents) : null;
    const options = {
        type: "none" as const,
        title: "Share",
        message: "Choose what to share",
        buttons: [...offered.map(label), "Cancel"],
        cancelId: offered.length,
        defaultId: 0,
        noLink: false
    };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    const source = offered[response];
    return source ? { source, sound: false } : null;
}

export function installScreenShare(server: () => string | null): void {
    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            const refuse = () => (callback as (streams: Streams | null) => void)(null);
            if (!request.videoRequested || !allowPermission("display-capture", request.securityOrigin, server())) {
                refuse();
                return;
            }
            shared = null;
            choose(request.frame).then(
                (chosen) => {
                    if (!chosen) {
                        refuse();
                        return;
                    }
                    pick = null;
                    shared = { id: chosen.source.id, displayId: chosen.source.display_id };
                    callback({
                        video: chosen.source,
                        ...(chosen.sound && request.audioRequested ? { audio: "loopback" as const } : {})
                    });
                },
                (caught: unknown) => {
                    console.error("[screen-share]", caught);
                    refuse();
                }
            );
        },
        { useSystemPicker: true }
    );
}
