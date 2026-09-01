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
 * Three kinds of terminal arrive here. A container terminal is opened through
 * polaris-hostd on the local box. A server terminal is an SSH shell on a
 * registered Host. A docker terminal is an interactive exec on a container
 * reached over its connection's own Docker transport, for the engines the daemon
 * does not broker. The credentials for the last two come back from the redeem
 * call, since only the web app can decrypt them.
 */

import { WebSocketServer } from "ws";
import { HostdClient } from "@polaris/hostd-client";
import { clampDim, openRootShell, openShell, openSshClient } from "@polaris/ssh";
import {
    DockerDriver,
    socketTransport,
    sshTransport,
    streamRpc,
    tcpTransport
} from "@polaris/docker";

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
    const interactive = ["terminal", "ssh", "ssh-root", "docker", "agent"];
    if (!ticket || !interactive.includes(ticket.mode)) {
        console.error(
            `polaris ws: rejecting connection - ${token ? "ticket redeem failed / wrong mode" : "no ticket"}`
        );
        ws.close(4001, "invalid ticket");
        return;
    }

    const session =
        ticket.mode === "ssh" || ticket.mode === "ssh-root"
            ? await openSshSession(ticket, ws)
            : ticket.mode === "docker"
              ? await openDockerSession(ticket, ws)
              : await openContainerSession(ticket, ws, ticket.mode === "agent");
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

/**
 * A container terminal, opened through the host daemon on the local box.
 *
 * `agent` attaches to the tmux session a coding agent is running in rather than
 * opening a shell beside it. That is the whole difference between watching the
 * agent and standing in the same container as it: attaching shows what it is
 * doing right now and lets somebody type at it, and detaching leaves it running.
 * The name is fixed by Polaris when the session starts, so it is not something a
 * client gets to name.
 *
 * It is attached through a shell, for one reason: TERM.
 *
 * An exec on a container inherits the container's environment, and a container
 * has no TERM unless its image set one - which the Node image does not. `tmux
 * attach-session` will not open a terminal it cannot look up, so it refused,
 * exited, and took the socket with it. What somebody saw was an empty black box
 * where the agent should have been, on a session whose agent was running the
 * whole time - and "See its screen", which reads the pane rather than attaching
 * to it, kept working and made it look like the terminal alone was broken.
 *
 * Only when there is nothing usable there already, so a container that does set
 * one keeps it. And a failure to attach ends in a shell with a sentence in it
 * rather than in a closed socket: standing in the container is worth more than
 * a box that goes away.
 */
const ATTACH_TO_AGENT = [
    "/bin/sh",
    "-c",
    [
        // Whichever terminal description this container actually carries.
        //
        // Naming one was not enough. A container gets no TERM unless its image
        // set one, and tmux will not open a terminal it cannot look up - but
        // WHICH descriptions exist depends on what the base image's ncurses
        // package shipped, and that is not something to assert from here. So
        // each is tried in turn and the first that works wins: the one already
        // set if there is one, then the two a terminal emulator would ask for,
        // then the one tmux uses for its own panes, then the last-resort entry
        // that every ncurses install has.
        "u=; for t in \"$TERM\" xterm-256color screen xterm ansi; do",
        // `dumb` is a terminal with no cursor addressing, so tmux refuses it
        // like a missing one - and it is what a stripped environment leaves
        // behind. Skipped rather than tried, so it costs no error line.
        '  { [ -n "$t" ] && [ "$t" != dumb ]; } || continue;',
        // Remembered, so the shell below inherits a terminal name rather than
        // the empty one this exec started with. A shell with no TERM is one
        // nobody can run an editor or a pager in, and the last candidate tried
        // is the most conservative entry there is - which is the right thing to
        // hand a plain shell even when it was not enough for tmux.
        '  u="$t"; TERM="$t" tmux attach-session -t polaris-agent && exit 0;',
        "done;",
        // Reached only when none of them opened. tmux has already said why on
        // this same terminal, above this line.
        'echo "polaris: could not attach to the agent terminal. This shell is inside the same container.";',
        '[ -n "$u" ] && { TERM="$u"; export TERM; };',
        // And it is a shell somebody can work in, as the account the agent runs
        // as rather than as root. The agent installs into a prefix inside its
        // own home, so a root shell with the image's PATH does not have the tool
        // that is running two feet away - which is exactly what the last person
        // to land here found when they typed its name.
        //
        // Both names come from the container's own environment, which the
        // session put there; naming the account here would be a second copy of
        // a decision that is made in one place.
        'a="$POLARIS_RUNAS"; h="$POLARIS_HOME";',
        'if [ -n "$h" ] && [ -d "$h" ]; then HOME="$h"; PATH="$h/.npm-global/bin:$PATH"; export HOME PATH; fi;',
        'if [ "$(id -u)" = 0 ] && [ -n "$a" ] && id "$a" >/dev/null 2>&1 && command -v su >/dev/null 2>&1; then',
        '  exec su -p "$a" -s /bin/sh;',
        "fi;",
        "exec /bin/sh"
    ].join(" ")
];

async function openContainerSession(ticket, ws, attachToAgent = false) {
    const client = new HostdClient();
    try {
        const cmd = attachToAgent ? ATTACH_TO_AGENT : ["/bin/sh"];
        const execId = await client.execCreate({ container: ticket.containerRef, cmd, tty: true });
        const stream = await client.execStart(execId);
        console.error(`polaris ws: terminal open for ${ticket.containerRef}`);
        return {
            stream,
            resize: (cols, rows) => client.execResize(execId, cols, rows).catch(() => undefined),
            close: () => stream.destroy()
        };
    } catch (error) {
        console.error(
            `polaris ws: exec failed for ${ticket.containerRef}:`,
            error?.message ?? error
        );
        ws.close(4002, "could not open terminal");
        return null;
    }
}

/**
 * An interactive exec on a container reached over its connection's own Docker
 * transport (a socket, a TLS-secured TCP engine, or SSH). The transport is
 * rebuilt from the target the redeem call resolved - the sidecar can decrypt
 * nothing itself - and the shell falls back to `sh` on an image without bash,
 * which is most of them.
 */
async function openDockerSession(ticket, ws) {
    const target = ticket.docker;
    if (!target) {
        ws.close(4004, "connection unavailable");
        return null;
    }
    let driver;
    try {
        driver = new DockerDriver(streamRpc(dockerTransport(target)));
        // `exec` replaces the shell, so a failed one would end the session rather
        // than fall through - hence the test before it, not a `||`.
        const exec = await driver.attach(ticket.containerRef, [
            "/bin/sh",
            "-c",
            "[ -x /bin/bash ] && exec /bin/bash; exec /bin/sh"
        ]);
        console.error(`polaris ws: docker terminal open for ${ticket.containerRef}`);
        return {
            stream: exec.stream,
            resize: (cols, rows) => exec.resize(clampDim(cols, 80, 500), clampDim(rows, 24, 300)),
            close: () => {
                exec.close();
                void driver.dispose();
            }
        };
    } catch (error) {
        console.error(
            `polaris ws: docker exec failed for ${ticket.containerRef}:`,
            error?.message ?? error
        );
        void driver?.dispose();
        ws.close(4002, "could not open terminal");
        return null;
    }
}

function dockerTransport(target) {
    if (target.transport === "socket") return socketTransport(target.socketPath);
    if (target.transport === "tcp") {
        return tcpTransport({
            host: target.host,
            port: target.port,
            tls: target.tls,
            ca: target.ca,
            cert: target.cert,
            key: target.key
        });
    }
    return sshTransport({
        host: target.host,
        port: target.port,
        username: target.username,
        auth: target.auth,
        pinnedHostKey: target.pinnedHostKey
    });
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
            resize: (cols, rows) =>
                channel.setWindow(clampDim(rows, 24, 300), clampDim(cols, 80, 500), 0, 0),
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
