/**
 * Whether another kind of Polaris than this one makes the account's sounds.
 *
 * Somebody with Polaris open in a browser and in the desktop app heard every
 * message twice, every call rang twice and every notice was drawn twice. The tabs
 * of one browser settle that between themselves (`device-once`), but the desktop
 * app keeps its storage apart from the browser's, so the two never saw each
 * other's claim. The only thing they share is the server, which already elects one
 * connection of the account to chime (`live-clients`) and now says on every frame
 * of the notification stream which kind of client that is. A client of the other
 * kind yields: the desktop app wins whenever it is open and willing to ring.
 *
 * The server cannot tell which computer a connection comes from, so the app open
 * on one machine also quiets a browser on another - but only while somebody is at
 * the app's machine. The app reports when its computer sits untouched
 * (`attention-report`), and then the browser being used elsewhere sounds instead.
 *
 * Nothing here can make Polaris silent. Until a frame says otherwise - a server
 * that predates this, a page without the stream - nobody yields.
 */

import { z } from "zod";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { LiveClientKind } from "@/lib/notifications/live-clients";

const frameSchema = z.object({ sounder: z.enum(["desktop", "browser"]).nullable().catch(null) });

/** The kind the server last said makes the sounds; null for nothing said. */
let sounder: LiveClientKind | null = null;

/** Read the elected kind off a notification stream frame. A frame that does not
 *  say - an older server - leaves nobody yielding. */
export function noteSounder(data: string): void {
    try {
        const frame = frameSchema.safeParse(JSON.parse(data));
        sounder = frame.success ? frame.data.sounder : null;
    } catch {
        sounder = null;
    }
}

/** Whether `mine` should leave the sounds to the kind the server elected. */
export function yieldsTo(mine: LiveClientKind, elected: LiveClientKind | null): boolean {
    return elected !== null && elected !== mine;
}

/** Whether this page should stay quiet because another kind of client sounds. */
export function anotherClientSounds(): boolean {
    return yieldsTo(desktopBridge() ? "desktop" : "browser", sounder);
}

/** Forget what the server said. Exists for tests. */
export function resetSounder(): void {
    sounder = null;
}
