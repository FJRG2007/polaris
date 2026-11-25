/**
 * The game console mode of the terminal sidecar (ws-server.mjs).
 */

import { sendPaced } from "./terminal-sessions.mjs";

/** How much of a console's past is replayed when it opens. */
export const CONSOLE_HISTORY_LINES = 400;

/**
 * A game server's live console: the recent part of its container's output and
 * then each line as it is printed, through the daemon's `docker logs --follow`
 * (Pterodactyl's Wings does the same on its websocket: the log tail on connect,
 * then "console output" as it arrives). Read-only by construction - nothing the
 * browser sends reaches the container. A command goes through the console's own
 * action, which checks `games.console` and audits it for every line.
 *
 * `openLogs` is the daemon's log call and `live` the sidecar's open terminals,
 * which an ended account closes; both are passed in so this can be tested.
 *
 * The follow ends when the container stops; the socket closes with a reason the
 * screen reads as "the server stopped", and it opens a new ticket when it runs.
 */
export async function followConsole(ticket, ws, { openLogs, live }) {
    let stream;
    try {
        stream = await openLogs({
            container: ticket.containerRef,
            follow: true,
            tail: CONSOLE_HISTORY_LINES
        });
    } catch (error) {
        console.error(`polaris ws: console failed for ${ticket.containerRef}:`, error?.message ?? error);
        ws.close(4002, "could not open console");
        return;
    }
    if ((stream.statusCode ?? 200) >= 300) {
        stream.resume();
        ws.close(4002, "could not open console");
        return;
    }
    if (ws.readyState !== ws.OPEN) {
        stream.destroy();
        return;
    }
    live.set(ws, ticket.userId);
    stream.on("data", (chunk) => sendPaced(ws, stream, chunk));
    stream.on("end", () => ws.close(1000, "console ended"));
    stream.on("error", () => ws.close(1000, "console ended"));
    // Only keep-alives are expected; anything else is dropped, never written.
    ws.on("message", () => undefined);
    ws.on("close", () => {
        live.delete(ws);
        stream.destroy();
    });
}
