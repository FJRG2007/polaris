/**
 * The sidecar's half of "This computer" sessions: the runner sockets, and the
 * terminals of sessions running on them (`docs/runner-protocol.md`).
 *
 * A runner dials `RUNNER_SOCKET_PATH` with its credential as a Bearer token and
 * is handed to one `RunnerRelay`. What it says goes to the web app over
 * loopback (`POST /api/computers/relay`); what the web app wants it to do
 * arrives on `POST /runner/send`.
 *
 * A terminal viewer and the runner's socket may sit on different nodes. When
 * the runner is here, output goes straight from the relay to the viewer's
 * socket. When it is not, the viewer's node asks the runner's node to watch on
 * its behalf (`watch`, renewed while the viewer stays, forgotten after
 * `REMOTE_WATCH_TTL_MS` without a renewal); that node posts each chunk to its
 * web app, which carries it over `pg_notify` to the viewer's node, whose web
 * app posts it back here on `POST /runner/output`. Every hop is bounded: a
 * remote watcher holds at most `REMOTE_INFLIGHT_BYTES` unsent and drops output
 * past that, exactly as a slow local viewer does.
 */

import os from "node:os";
import { RunnerRelay } from "@polaris/core/runner-relay";
import { RUNNER_CLOSE, RUNNER_LIMITS, RUNNER_SOCKET_PATH } from "@polaris/core/runner-protocol";

export { RUNNER_LIMITS, RUNNER_SOCKET_PATH };

/** How long a remote watch lives without a renewal. */
export const REMOTE_WATCH_TTL_MS = 90_000;
/** How often a viewer renews its remote watch. */
const REMOTE_WATCH_RENEW_MS = 30_000;
/** Terminal output one remote watch may have in flight before it drops some. */
export const REMOTE_INFLIGHT_BYTES = 256 * 1024;
/** A frame that waits on a person (a permission prompt) holds the web app's
 *  answer for up to two minutes; this allows for that. */
const FRAME_TIMEOUT_MS = 150_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {{ appPort: number, internalKey: string, node?: string, fetch?: typeof fetch, log?: (line: string) => void }} options
 */
export function createRunnerSidecar(options) {
    const node = options.node ?? os.hostname();
    const doFetch = options.fetch ?? fetch;
    const log = options.log ?? ((line) => console.error(line));

    async function app(body, timeoutMs) {
        const res = await doFetch(`http://127.0.0.1:${options.appPort}/api/computers/relay`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-key": options.internalKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) throw new Error(`relay answered ${res.status}`);
        return res.json();
    }

    const relay = new RunnerRelay({
        authenticate: async (token) => (await app({ op: "auth", token }, 10_000))?.runner ?? null,
        presence: async (runner, online) => {
            await app({ op: "presence", runner, online }, 10_000);
        },
        deliver: async (runner, message) =>
            (await app({ op: "frame", runner, message }, FRAME_TIMEOUT_MS))?.reply ?? null,
        log
    });

    /** Viewers here of a runner held on another node, by `runnerId:sessionId`. */
    const remoteViewers = new Map();
    /** Watches held here for viewers on other nodes, by `runnerId:sessionId:node`. */
    const remoteWatches = new Map();

    /** A runner socket, once upgraded. */
    function acceptRunner(ws, req) {
        ws.on("error", (err) => log(`polaris ws: runner socket error - ${err?.message ?? err}`));
        const header = String(req.headers.authorization ?? "");
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const handlers = relay.accept(ws, token);
        ws.on("message", (data, isBinary) => {
            // The protocol is JSON text frames only.
            if (isBinary) return ws.close(RUNNER_CLOSE.protocol, "text frames only");
            handlers.message(data.toString());
        });
        ws.on("close", handlers.close);
    }

    /** Watch a session's output here and post it to another node's viewer. */
    function watchFor(runnerId, sessionId, viewerNode) {
        const key = `${runnerId}:${sessionId}:${viewerNode}`;
        const existing = remoteWatches.get(key);
        if (existing) {
            existing.renewedAt = Date.now();
            return;
        }
        const watch = { renewedAt: Date.now(), inflight: 0, chain: Promise.resolve(), unwatch: () => undefined };
        watch.unwatch = relay.watchTerminal(runnerId, sessionId, {
            get bufferedAmount() {
                return watch.inflight;
            },
            write(bytes) {
                if (watch.inflight + bytes.length > REMOTE_INFLIGHT_BYTES) return;
                watch.inflight += bytes.length;
                const data = bytes.toString("base64");
                // One chunk at a time, so the viewer sees them in order.
                watch.chain = watch.chain
                    .then(() => app({ op: "output", node: viewerNode, runnerId, sessionId, data }, 10_000))
                    .catch(() => undefined)
                    .finally(() => {
                        watch.inflight -= bytes.length;
                    });
            }
        });
        remoteWatches.set(key, watch);
    }

    function unwatchFor(runnerId, sessionId, viewerNode) {
        const key = `${runnerId}:${sessionId}:${viewerNode}`;
        remoteWatches.get(key)?.unwatch();
        remoteWatches.delete(key);
    }

    /** A command for a runner, handed here by this node's web app. */
    function send(runnerId, command) {
        if (command.type === "close") return relay.close(runnerId);
        if (command.type === "watch" || command.type === "unwatch") {
            if (!relay.holds(runnerId)) return false;
            if (!UUID.test(command.sessionId ?? "") || typeof command.node !== "string" || !command.node) return false;
            if (command.type === "watch") watchFor(runnerId, command.sessionId, command.node.slice(0, 255));
            else unwatchFor(runnerId, command.sessionId, command.node.slice(0, 255));
            return true;
        }
        try {
            return relay.send(runnerId, command);
        } catch {
            // A frame this build would refuse to send.
            return false;
        }
    }

    /** Output for viewers here, carried from the runner's node. */
    function output(runnerId, sessionId, data) {
        const set = remoteViewers.get(`${runnerId}:${sessionId}`);
        if (!set) return 0;
        const bytes = Buffer.from(data, "base64");
        for (const ws of set) if (ws.bufferedAmount <= RUNNER_LIMITS.bufferedBytes) ws.send(bytes);
        return set.size;
    }

    /**
     * The web app's loopback calls for runners. Returns null for a path that
     * is not one of these, so the caller can try its own.
     */
    async function internal(path, readBody) {
        if (path !== "/runner/send" && path !== "/runner/output") return null;
        let body;
        try {
            body = JSON.parse(await readBody(RUNNER_LIMITS.frameBytes + 4096));
        } catch {
            return { status: 400, body: { error: "invalid body" } };
        }
        if (!UUID.test(String(body?.runnerId ?? ""))) return { status: 400, body: { error: "invalid body" } };
        if (path === "/runner/send") {
            if (typeof body.command?.type !== "string") return { status: 400, body: { error: "invalid body" } };
            return { status: 200, body: { held: send(body.runnerId, body.command) } };
        }
        if (!UUID.test(String(body.sessionId ?? "")) || typeof body.data !== "string")
            return { status: 400, body: { error: "invalid body" } };
        return { status: 200, body: { viewers: output(body.runnerId, body.sessionId, body.data) } };
    }

    /** A command for a runner from a terminal here, wherever the runner is. */
    function command(runnerId, frame) {
        if (relay.holds(runnerId)) return Promise.resolve(send(runnerId, frame));
        return app({ op: "command", runnerId, command: frame }, 10_000)
            .then((answer) => answer?.sent === true)
            .catch(() => false);
    }

    /**
     * The terminal of a session running on a computer, for a redeemed `agent`
     * ticket whose session is placed there. Input goes as `terminal.input`
     * frames no larger than the protocol's chunk; output comes back through
     * the relay (here) or the remote watch (elsewhere).
     */
    async function openTerminal(ticket, ws) {
        const { runnerId, sessionId } = ticket.runner;
        const local = relay.holds(runnerId);
        let stop;
        if (local) {
            stop = relay.watchTerminal(runnerId, sessionId, {
                get bufferedAmount() {
                    return ws.bufferedAmount;
                },
                write: (bytes) => ws.send(bytes)
            });
        } else {
            const key = `${runnerId}:${sessionId}`;
            let set = remoteViewers.get(key);
            if (!set) remoteViewers.set(key, (set = new Set()));
            set.add(ws);
            const renew = setInterval(
                () => void command(runnerId, { type: "watch", sessionId, node }),
                REMOTE_WATCH_RENEW_MS
            );
            stop = () => {
                clearInterval(renew);
                const current = remoteViewers.get(key);
                current?.delete(ws);
                if (current && current.size === 0) {
                    remoteViewers.delete(key);
                    void command(runnerId, { type: "unwatch", sessionId, node });
                }
            };
        }
        let ended = false;
        ws.on("close", () => {
            ended = true;
            stop();
            void command(runnerId, { type: "terminal.detach", sessionId });
        });
        const watched = local || (await command(runnerId, { type: "watch", sessionId, node }));
        if (ended) return;
        if (!watched || !(await command(runnerId, { type: "terminal.attach", sessionId, cols: 120, rows: 40 }))) {
            ws.close(4002, "computer offline");
            return;
        }
        // Keystrokes stay in order even when each one is a loopback call.
        let chain = Promise.resolve(true);
        const ordered = (frame) => (chain = chain.then(() => command(runnerId, frame)));
        ws.on("message", (data, isBinary) => {
            if (!isBinary) {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg && msg.resize) {
                        const cols = Math.min(1000, Math.max(1, Math.trunc(Number(msg.resize.cols) || 80)));
                        const rows = Math.min(1000, Math.max(1, Math.trunc(Number(msg.resize.rows) || 24)));
                        void ordered({ type: "terminal.resize", sessionId, cols, rows });
                        return;
                    }
                    if (msg && msg.ping) return;
                } catch {
                    // Not JSON: typed input.
                }
            }
            const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
            for (let at = 0; at < bytes.length; at += RUNNER_LIMITS.terminalChunkBytes) {
                const chunk = bytes.subarray(at, at + RUNNER_LIMITS.terminalChunkBytes);
                void ordered({ type: "terminal.input", sessionId, data: chunk.toString("base64") });
            }
        });
    }

    /** Drop silent runners and expired remote watches. */
    function sweep() {
        relay.sweep();
        const cutoff = Date.now() - REMOTE_WATCH_TTL_MS;
        for (const [key, watch] of remoteWatches) {
            if (watch.renewedAt >= cutoff) continue;
            watch.unwatch();
            remoteWatches.delete(key);
        }
    }

    return { relay, node, acceptRunner, internal, openTerminal, sweep, send, output };
}
