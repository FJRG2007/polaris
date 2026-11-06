/**
 * The desktop app telling the server whether anybody is at its computer.
 *
 * The server hands the account's sounds to the desktop app whenever one is open
 * (`live-clients`), and it cannot see which computer a connection is on - so an
 * app left running at home kept a browser somebody was using elsewhere quiet,
 * calls included. The app asks the operating system how long the machine has
 * gone untouched, and this sends the answer on the connection it holds, so the
 * election moves to the browser while the desk is empty and back when somebody
 * sits down.
 *
 * Only the desktop app reports. A browser cannot see past its own page, and a
 * tab behind an editor is not a person gone, so it never claims to be away. An
 * app older than `systemIdle`, or a server that names no connection, sends
 * nothing, and the server keeps treating the app as attended - how it worked
 * before.
 */

import { z } from "zod";
import { desktopBridge } from "@/lib/desktop-bridge";

const ENDPOINT = "/api/notifications/attention";

/** How often the computer is asked. The election re-runs on the stream's next
 *  tick, so a change is felt within about twice this. */
const CHECK_MS = 5000;

/** Said again even when nothing changed, because the server forgets it if the
 *  connection's entry is ever dropped and re-made. */
const REPEAT_MS = 30_000;

const frameSchema = z.object({ connection: z.string().uuid().nullable().catch(null) });

/** The connection this page holds, from the last frame it took off the wire. */
let connection: string | null = null;

/** Note which connection a frame came in on. Only the page holding the
 *  connection reports for it; a page relayed the frame by another stays out. */
export function noteStreamConnection(data: string, owner: boolean): void {
    if (!owner) return;
    try {
        const frame = frameSchema.safeParse(JSON.parse(data));
        if (frame.success && frame.data.connection) connection = frame.data.connection;
    } catch {
        // Not a frame this understands; keep the last one.
    }
}

/** Whether the system's answer means nobody is at the computer. `unknown` is
 *  not away: a system that cannot say must not cost its owner a ring. */
export function awayFrom(state: string): boolean {
    return state === "idle" || state === "locked";
}

/**
 * Keep reporting while the page lives. Does nothing outside the desktop app or
 * in one too old to say. Answers the way to stop.
 */
export function reportDesktopAttention(): () => void {
    const bridge = desktopBridge();
    if (!bridge?.systemIdle) return () => undefined;
    const ask = () => bridge.systemIdle?.() ?? Promise.resolve("unknown");
    let said: { connection: string; away: boolean; at: number } | null = null;
    let busy = false;

    async function check(): Promise<void> {
        if (busy || !connection) return;
        busy = true;
        try {
            const away = awayFrom(await ask().catch(() => "unknown"));
            const now = Date.now();
            if (said?.connection === connection && said.away === away && now - said.at < REPEAT_MS)
                return;
            const response = await fetch(ENDPOINT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ connection, away })
            });
            if (response.ok) said = { connection, away, at: now };
        } catch {
            // Offline or the server is restarting; the next check tries again.
        } finally {
            busy = false;
        }
    }

    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => clearInterval(timer);
}

/** Forget the connection. Exists for tests. */
export function resetStreamConnection(): void {
    connection = null;
}
