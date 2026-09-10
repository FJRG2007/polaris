/**
 * Sharing a screen or a window, for a call's screen share and a clip recording.
 *
 * Electron has no picker of its own for `getDisplayMedia`. Where macOS offers
 * its system picker, that is what is shown. Elsewhere the screens and windows
 * `desktopCapturer` lists are offered in a native dialog; on Linux under
 * Wayland the desktop's own portal has already asked, and hands back the one
 * source that was picked. Only the configured Polaris may ask, and dismissing
 * the dialog shares nothing.
 */

import { allowPermission } from "./permissions";
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

function label(source: DesktopCapturerSource): string {
    const name = source.name.trim() || (source.id.startsWith("screen:") ? "Screen" : "Window");
    return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 3)}...` : name;
}

/** The source the person picked, or null when they picked none. */
async function choose(frame: WebFrameMain | null): Promise<DesktopCapturerSource | null> {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 }
    });
    if (sources.length === 0) return null;
    if (process.platform === "linux" && sources.length === 1) return sources[0] ?? null;

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
    const { response } = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
    return offered[response] ?? null;
}

export function installScreenShare(server: () => string | null): void {
    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            const refuse = () => (callback as (streams: Streams | null) => void)(null);
            if (
                !request.videoRequested ||
                !allowPermission("display-capture", request.securityOrigin, server())
            ) {
                refuse();
                return;
            }
            choose(request.frame).then(
                (source) => (source ? callback({ video: source }) : refuse()),
                (caught: unknown) => {
                    console.error("[screen-share]", caught);
                    refuse();
                }
            );
        },
        { useSystemPicker: true }
    );
}
