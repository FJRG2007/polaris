/**
 * The sidecar's half of the Polaris Terminal remote-control relay
 * (docs/terminal-integration.md, "Remote control").
 *
 * Two kinds of socket dial `TERMINAL_SOCKET_PATH`, each with a Polaris key as a
 * Bearer token: a terminal (`?role=instance`, its own `terminal` key) keeping
 * one outbound socket so it can be reached behind NAT, and a controller
 * (`?role=controller`, any key holding `terminal.control`) - the CLI, another
 * terminal, a script. A controller sends
 * `{ "type": "request", "instance": <id>, "envelope": <RequestEnvelope> }`; the
 * relay never reads the envelope, it checks the caller may reach that instance
 * and passes it through. The terminal answers with
 * `{ "type": "response", "id": <relay id>, "envelope": <ResponseEnvelope> }`,
 * which reaches the controller as `{ "type": "response", "instance", "envelope" }`.
 *
 * The path sits under `/api/deploy/ws`, the prefix the edge already sends to
 * this process, so an existing install reaches it with no new router.
 *
 * A terminal and its controller may sit on different nodes. The controller's
 * node asks its web app where the instance is (`route`); when it is elsewhere,
 * the request goes to that node through the web app (`forward`, carried over
 * `pg_notify`) and arrives here on `POST /terminal/deliver`, and the answer
 * comes back the same way (`reply`, then `POST /terminal/reply`).
 *
 * Every hop is bounded: frame size, requests in flight per controller, a
 * per-socket rate, a deadline on each request, and a terminal that never says
 * hello is dropped.
 */

import { randomUUID } from "node:crypto";

export const TERMINAL_SOCKET_PATH = "/api/deploy/ws/terminal";

export const TERMINAL_LIMITS = Object.freeze({
    /** The largest frame either side may send. */
    frameBytes: 256 * 1024,
    /** Requests one controller may have unanswered at once. */
    inflight: 64,
    /** How long a request waits for the terminal's answer. */
    requestMs: 60_000,
    /** How long a terminal has to say hello after its socket opens. */
    helloMs: 10_000,
    /** Frames a socket may send in a burst, refilled at `ratePerSecond`. */
    burst: 200,
    ratePerSecond: 50,
    /** Written before a slow socket is cut off rather than buffered without end. */
    bufferedBytes: 4 * 1024 * 1024
});

/** Close codes the relay uses, beside the WebSocket standard ones. */
export const TERMINAL_CLOSE = Object.freeze({
    unauthorized: 4001,
    replaced: 4002,
    protocol: 4003,
    flood: 4004,
    slow: 4005
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A short reported string, or null: what the terminal says about itself. */
function label(value) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

/**
 * @param {{
 *   app: (body: object) => Promise<any>,
 *   node: string,
 *   now?: () => number,
 *   log?: (line: string) => void
 * }} deps `app` is the web app's loopback route (`POST /api/terminal/relay`).
 */
export function createTerminalRelay(deps) {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((line) => console.error(line));

    /** The one live, greeted socket of each instance held here. */
    const instances = new Map();
    /** Requests sent to an instance held here, by relay id. */
    const awaiting = new Map();
    /** Requests a controller here is waiting on, by relay id. */
    const requests = new Map();
    const connections = new Set();

    function send(conn, frame) {
        if (conn.closed) return;
        if (conn.socket.bufferedAmount > TERMINAL_LIMITS.bufferedBytes) {
            close(conn, TERMINAL_CLOSE.slow, "too slow");
            return;
        }
        conn.socket.send(JSON.stringify(frame));
    }

    function close(conn, code, reason) {
        if (conn.closed) return;
        conn.closed = true;
        try {
            conn.socket.close(code, reason);
        } catch {
            // Already gone.
        }
        cleanup(conn);
    }

    function cleanup(conn) {
        conn.closed = true;
        if (!connections.delete(conn)) return;
        if (conn.role === "instance" && conn.identity && instances.get(conn.identity.instanceId) === conn) {
            instances.delete(conn.identity.instanceId);
            void deps
                .app({ op: "presence", instanceId: conn.identity.instanceId, node: deps.node, online: false })
                .catch(() => null);
        }
        for (const [id, request] of requests) if (request.conn === conn) requests.delete(id);
        for (const [id, wait] of awaiting) {
            if (wait.instance !== conn) continue;
            awaiting.delete(id);
            answer(wait, { type: "error", code: "offline" });
        }
    }

    /** The answer to a request held here, to its controller here or on its node. */
    function answer(wait, frame) {
        if (wait.origin === deps.node) {
            finish(wait.id, frame);
            return;
        }
        void deps.app({ op: "reply", node: wait.origin, id: wait.id, frame }).catch(() => null);
    }

    /** A request's answer reaching the controller waiting on it, if it still is. */
    function finish(id, frame) {
        const request = requests.get(id);
        if (!request) return false;
        requests.delete(id);
        const out = { ...frame, instance: request.instanceId };
        if (request.requestId) out.request_id = request.requestId;
        send(request.conn, out);
        return true;
    }

    /** Hand a request to an instance held here. False when it is not. */
    function deliver(instanceId, id, origin, envelope) {
        const instance = instances.get(instanceId);
        if (!instance || instance.closed) return false;
        awaiting.set(id, { id, origin, instance, at: now() });
        send(instance, { type: "request", id, envelope });
        return true;
    }

    function allow(conn) {
        const at = now();
        conn.tokens = Math.min(
            TERMINAL_LIMITS.burst,
            conn.tokens + ((at - conn.refilledAt) / 1000) * TERMINAL_LIMITS.ratePerSecond
        );
        conn.refilledAt = at;
        if (conn.tokens < 1) return false;
        conn.tokens -= 1;
        return true;
    }

    async function onInstanceFrame(conn, frame) {
        if (frame.type === "hello") {
            if (conn.greeted) return;
            conn.greeted = true;
            const id = conn.identity.instanceId;
            const older = instances.get(id);
            instances.set(id, conn);
            if (older && older !== conn) close(older, TERMINAL_CLOSE.replaced, "replaced");
            await deps.app({
                op: "presence",
                instanceId: id,
                node: deps.node,
                online: true,
                name: label(frame.name),
                os: label(frame.os),
                version: label(frame.version)
            });
            send(conn, { type: "ready", instance: id });
            return;
        }
        if (!conn.greeted) {
            close(conn, TERMINAL_CLOSE.protocol, "hello first");
            return;
        }
        if (frame.type === "response" && typeof frame.id === "string") {
            const wait = awaiting.get(frame.id);
            // Only the instance a request went to may answer it.
            if (!wait || wait.instance !== conn) return;
            awaiting.delete(frame.id);
            answer(wait, { type: "response", envelope: frame.envelope ?? null });
            return;
        }
        if (frame.type === "ping") send(conn, { type: "pong" });
    }

    async function onControllerFrame(conn, frame) {
        if (frame.type === "ping") {
            send(conn, { type: "pong" });
            return;
        }
        if (frame.type !== "request" || typeof frame.instance !== "string" || !UUID.test(frame.instance)) {
            close(conn, TERMINAL_CLOSE.protocol, "invalid frame");
            return;
        }
        const instanceId = frame.instance;
        const requestId = typeof frame.envelope?.request_id === "string" ? frame.envelope.request_id.slice(0, 200) : null;
        const fail = (code) => {
            const out = { type: "error", instance: instanceId, code };
            if (requestId) out.request_id = requestId;
            send(conn, out);
        };
        let inflight = 0;
        for (const request of requests.values()) if (request.conn === conn) inflight += 1;
        if (inflight >= TERMINAL_LIMITS.inflight) return fail("busy");

        // Asked each time rather than cached: a grant withdrawn or a key revoked
        // stops the next request, not the next reconnect.
        const route = await deps
            .app({ op: "route", userId: conn.identity.userId, keyId: conn.identity.keyId, instanceId })
            .catch(() => null);
        if (conn.closed) return;
        if (!route?.allowed) return fail("not_found");
        if (!route.node) return fail("offline");

        const id = randomUUID();
        requests.set(id, { conn, instanceId, requestId, at: now() });
        if (route.node === deps.node) {
            if (!deliver(instanceId, id, deps.node, frame.envelope ?? null)) {
                requests.delete(id);
                fail("offline");
            }
            return;
        }
        const sent = await deps
            .app({ op: "forward", node: route.node, origin: deps.node, id, instanceId, envelope: frame.envelope ?? null })
            .catch(() => null);
        if (!sent?.ok && requests.delete(id)) fail("offline");
    }

    /**
     * Take a socket once upgraded. `role`, `token` and the `headers` that say
     * where it came from (address, user-agent) are the upgrade request's;
     * nothing the socket sends is read before its key is checked.
     */
    function accept(socket, { role, token, headers = {} }) {
        const at = now();
        const conn = {
            socket,
            role,
            identity: null,
            greeted: false,
            openedAt: at,
            tokens: TERMINAL_LIMITS.burst,
            refilledAt: at,
            closed: false
        };
        connections.add(conn);
        const pending = [];
        let ready = false;
        let chain = Promise.resolve();

        const handle = (raw) => {
            if (conn.closed) return;
            if (!allow(conn)) {
                close(conn, TERMINAL_CLOSE.flood, "too many frames");
                return;
            }
            if (raw.length > TERMINAL_LIMITS.frameBytes) {
                close(conn, 1009, "frame too large");
                return;
            }
            let frame;
            try {
                frame = JSON.parse(raw);
            } catch {
                frame = null;
            }
            if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
                close(conn, TERMINAL_CLOSE.protocol, "invalid frame");
                return;
            }
            // One at a time, so a terminal's hello lands before what follows it.
            chain = chain
                .then(() => (role === "instance" ? onInstanceFrame(conn, frame) : onControllerFrame(conn, frame)))
                .catch((caught) => log(`polaris ws: terminal frame failed - ${caught?.message ?? caught}`));
        };

        if (role !== "instance" && role !== "controller") {
            close(conn, TERMINAL_CLOSE.protocol, "unknown role");
        } else {
            void (async () => {
                const identity = token
                    ? await deps.app({ op: "auth", token, role, headers }).catch(() => null)
                    : null;
                if (conn.closed) return;
                const valid =
                    identity &&
                    typeof identity.userId === "string" &&
                    (role === "controller" || typeof identity.instanceId === "string");
                if (!valid) {
                    close(conn, TERMINAL_CLOSE.unauthorized, "unauthorized");
                    return;
                }
                conn.identity = identity;
                ready = true;
                for (const raw of pending.splice(0)) handle(raw);
            })();
        }

        return {
            message: (raw) => {
                if (conn.closed) return;
                if (ready) handle(raw);
                else if (pending.length < 16 && raw.length <= TERMINAL_LIMITS.frameBytes) pending.push(raw);
                else close(conn, TERMINAL_CLOSE.flood, "too many frames");
            },
            close: () => cleanup(conn)
        };
    }

    /** Close what has outlived its deadline. The caller runs this on a timer. */
    function sweep() {
        const at = now();
        for (const conn of connections) {
            if (conn.role === "instance" && !conn.greeted && at - conn.openedAt > TERMINAL_LIMITS.helloMs)
                close(conn, TERMINAL_CLOSE.protocol, "no hello");
        }
        for (const [id, request] of requests) {
            if (at - request.at <= TERMINAL_LIMITS.requestMs) continue;
            finish(id, { type: "error", code: "timeout" });
        }
        for (const [id, wait] of awaiting) if (at - wait.at > TERMINAL_LIMITS.requestMs) awaiting.delete(id);
    }

    /** The web app's loopback calls (`POST /terminal/deliver`, `/terminal/reply`). */
    function internal(path, body) {
        if (path === "/terminal/deliver") {
            const ok =
                typeof body?.instanceId === "string" &&
                typeof body.id === "string" &&
                typeof body.origin === "string" &&
                deliver(body.instanceId, body.id, body.origin, body.envelope ?? null);
            // Not held here after all: the controller is told rather than left waiting.
            if (!ok && typeof body?.id === "string" && typeof body.origin === "string")
                void deps
                    .app({ op: "reply", node: body.origin, id: body.id, frame: { type: "error", code: "offline" } })
                    .catch(() => null);
            return { status: 200, body: { held: ok } };
        }
        if (path === "/terminal/reply") {
            const frame = body?.frame;
            const ok =
                typeof body?.id === "string" &&
                frame &&
                (frame.type === "response" || frame.type === "error") &&
                finish(
                    body.id,
                    frame.type === "response"
                        ? { type: "response", envelope: frame.envelope ?? null }
                        : { type: "error", code: String(frame.code ?? "offline").slice(0, 40) }
                );
            return { status: 200, body: { delivered: Boolean(ok) } };
        }
        return null;
    }

    /**
     * Close the terminals whose key was revoked, switched off or expired, or
     * whose owner was banned, while their socket stayed open. Controllers are
     * checked on every request instead. The caller runs this once a minute.
     */
    async function checkStanding() {
        const held = [...instances.keys()];
        if (held.length === 0) return;
        const answer = await deps.app({ op: "standing", instanceIds: held }).catch(() => null);
        const ended = Array.isArray(answer?.ended) ? answer.ended : [];
        for (const id of ended) {
            const conn = typeof id === "string" ? instances.get(id) : null;
            if (conn) close(conn, TERMINAL_CLOSE.unauthorized, "signed out");
        }
    }

    /** Close every socket, for a shutdown. */
    function endAll(code, reason) {
        for (const conn of [...connections]) close(conn, code, reason);
    }

    return {
        accept,
        sweep,
        checkStanding,
        internal,
        endAll,
        holds: (instanceId) => instances.has(instanceId),
        get size() {
            return instances.size;
        }
    };
}
