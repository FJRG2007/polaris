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
 * Two kinds of terminal arrive here. A container terminal is opened through
 * polaris-hostd on the local box. A server terminal is an SSH shell on a
 * registered Host; the credentials for it come back from the redeem call, since
 * only the web app can decrypt them.
 */

import { WebSocketServer } from "ws";
import { HostdClient } from "@polaris/hostd-client";
import { clampDim, openRootShell, openShell, openSshClient } from "@polaris/ssh";

const port = Number(process.env.POLARIS_WS_PORT || 3001);
const appPort = Number(process.env.PORT || 3000);
const internalKey = process.env.POLARIS_AUTH_SECRET || "";

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
    if (!ticket || (ticket.mode !== "terminal" && ticket.mode !== "ssh" && ticket.mode !== "ssh-root")) {
        console.error(`polaris ws: rejecting connection - ${token ? "ticket redeem failed / wrong mode" : "no ticket"}`);
        ws.close(4001, "invalid ticket");
        return;
    }

    const overSsh = ticket.mode === "ssh" || ticket.mode === "ssh-root";
    const session = overSsh ? await openSshSession(ticket, ws) : await openContainerSession(ticket, ws);
    if (!session) return;

    session.stream.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    session.stream.on("close", () => ws.close());
    session.stream.on("error", () => ws.close());

    ws.on("message", (data, isBinary) => {
        if (!isBinary) {
            // Text frames are control messages: { resize: { cols, rows } } or ping.
            try {
                const msg = JSON.parse(data.toString());
                if (msg && msg.resize) {
                    session.resize(msg.resize.cols, msg.resize.rows);
                    return;
                }
                if (msg && msg.ping) return;
            } catch {
                // Not JSON: fall through and treat as input bytes.
            }
        }
        session.stream.write(data);
    });

    ws.on("close", () => session.close());
});

/** A container terminal, opened through the host daemon on the local box. */
async function openContainerSession(ticket, ws) {
    const client = new HostdClient();
    try {
        const execId = await client.execCreate({ container: ticket.containerRef, cmd: ["/bin/sh"], tty: true });
        const stream = await client.execStart(execId);
        console.error(`polaris ws: terminal open for ${ticket.containerRef}`);
        return {
            stream,
            resize: (cols, rows) => client.execResize(execId, cols, rows).catch(() => undefined),
            close: () => stream.destroy()
        };
    } catch (error) {
        console.error(`polaris ws: exec failed for ${ticket.containerRef}:`, error?.message ?? error);
        ws.close(4002, "could not open terminal");
        return null;
    }
}

/**
 * A shell on a registered server. The pinned host key travels with the ticket, so
 * the sidecar verifies the server exactly as the rest of Polaris does rather than
 * connecting blind - a terminal is the one place where trusting the wrong machine
 * means typing at it.
 */
async function openSshSession(ticket, ws) {
    const target = ticket.ssh;
    if (!target) {
        ws.close(4004, "server unavailable");
        return null;
    }
    try {
        const client = await openSshClient({
            host: target.host,
            port: target.port,
            username: target.username,
            auth: target.privateKey
                ? { method: "key", privateKey: target.privateKey, passphrase: target.passphrase }
                : { method: "password", password: target.password },
            // An empty array means "pinning required, nothing known", which the
            // client refuses. A host with no pinned key is a bug, and a terminal
            // is the last place to paper over it by trusting whatever answers.
            pinnedHostKey: target.hostKey ?? []
        });
        // Which of the two the ticket says, never what the client asked for: the
        // web app already refused a root ticket for a server that was never granted
        // sudo, and that decision is not one to re-take here on weaker information.
        const asRoot = ticket.mode === "ssh-root";
        const channel = asRoot ? await openRootShell(client) : await openShell(client);
        console.error(
            `polaris ws: ${asRoot ? "root shell" : "shell"} open on ${target.username}@${target.host}`
        );
        return {
            stream: channel,
            resize: (cols, rows) => channel.setWindow(clampDim(rows, 24, 300), clampDim(cols, 80, 500), 0, 0),
            close: () => {
                channel.end();
                client.end();
            }
        };
    } catch (error) {
        console.error(`polaris ws: ssh failed for ${target.host}:`, error?.message ?? error);
        ws.close(4003, "could not open a shell on the server");
        return null;
    }
}

async function redeem(token) {
    // Redeem via the web app's internal loopback route: this process runs outside
    // the Next standalone bundle and cannot resolve @polaris/db to query Prisma.
    try {
        const res = await fetch(`http://127.0.0.1:${appPort}/api/deploy/terminal/redeem`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-key": internalKey },
            body: JSON.stringify({ token })
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}
