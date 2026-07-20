/**
 * Deploy terminal WebSocket sidecar.
 *
 * Next standalone has no custom server, so interactive terminals run in this
 * small process launched alongside `node server.js` by the entrypoint. It listens
 * on an internal port (never published); the reverse proxy forwards
 * /api/deploy/ws to it. Auth is a one-shot ticket presented over
 * Sec-WebSocket-Protocol (the browser cannot set an Authorization header on a
 * WebSocket); the ticket is redeemed and burned here, and the authorized target
 * and container are derived server-side - the client never sends the exec command.
 *
 * This handles the local host (via polaris-hostd). Remote-server terminals over
 * SSH are wired in a follow-up (they need host-credential decryption shared with
 * the web app).
 */

import { WebSocketServer } from "ws";
import { prisma } from "@polaris/db";
import { hashToken } from "@polaris/core/tokens";
import { HostdClient } from "@polaris/hostd-client";

const port = Number(process.env.POLARIS_WS_PORT || 3001);

const wss = new WebSocketServer({
    port,
    path: "/api/deploy/ws",
    // Accept and echo the offered subprotocol (the ticket token).
    handleProtocols: (protocols) => [...protocols][0] ?? false
});

wss.on("listening", () => console.error(`polaris deploy ws sidecar on :${port}`));

wss.on("connection", async (ws, req) => {
    const token = (req.headers["sec-websocket-protocol"] || "").split(",")[0]?.trim();
    const ticket = token ? await redeem(token) : null;
    if (!ticket || ticket.mode !== "terminal") {
        ws.close(4001, "invalid ticket");
        return;
    }

    // Local host only for now.
    const client = new HostdClient();
    let socket;
    let execId;
    try {
        execId = await client.execCreate({ container: ticket.containerRef, cmd: ["/bin/sh"], tty: true });
        socket = await client.execStart(execId);
    } catch {
        ws.close(4002, "could not open terminal");
        return;
    }

    socket.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    socket.on("close", () => ws.close());
    socket.on("error", () => ws.close());

    ws.on("message", (data, isBinary) => {
        if (!isBinary) {
            // Text frames are control messages: { resize: { cols, rows } } or ping.
            try {
                const msg = JSON.parse(data.toString());
                if (msg && msg.resize) {
                    client.execResize(execId, msg.resize.cols, msg.resize.rows).catch(() => undefined);
                    return;
                }
                if (msg && msg.ping) return;
            } catch {
                // Not JSON: fall through and treat as input bytes.
            }
        }
        socket.write(data);
    });

    ws.on("close", () => socket.destroy());
});

async function redeem(token) {
    const ticket = await prisma.deployTicket.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!ticket || ticket.usedAt || ticket.expiresAt < new Date()) return null;
    await prisma.deployTicket.update({ where: { id: ticket.id }, data: { usedAt: new Date() } });
    return ticket;
}
