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
 * A pane's output is streamed only while somebody watches it. A controller or
 * viewer sends `{ "type": "watch", "instance", "pane" }`; the first watcher of
 * a pane makes the relay send the terminal `{ "type": "attach", "pane" }`, and
 * the last one leaving sends `{ "type": "detach", "pane" }`. The terminal's
 * `{ "type": "output", "pane", "data" }` frames (base64 of the pane's bytes)
 * reach every watcher as `{ "type": "output", "instance", "pane", "data" }`,
 * with `"gap": true` on the first frame after some were dropped for going over
 * the pane's byte rate. A watcher on another node is one entry on the holding
 * node, so a pane's output crosses nodes once per node, not once per watcher.
 *
 * A browser cannot set an Authorization header on a WebSocket, so the web
 * screen dials `?role=viewer` with a one-shot ticket for one terminal in
 * `Sec-WebSocket-Protocol`; it may only reach that terminal.
 *
 * Every hop is bounded: frame size, requests in flight per controller, a
 * per-socket rate, a deadline on each request, watches per socket and
 * watchers per pane, a byte rate per pane, and a terminal that never says
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
    bufferedBytes: 4 * 1024 * 1024,
    /** Panes one socket may watch at once. */
    watches: 16,
    /** Sockets on one node watching the same pane. */
    watchers: 32,
    /** A pane's output, in bytes of frame, refilled per second up to the burst. */
    outputBytesPerSecond: 256 * 1024,
    outputBurstBytes: 1024 * 1024
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

/** A pane id as the terminal names it: opaque, short, printable. */
const PANE = /^[\x21-\x7e]{1,200}$/;

/**
 * Requests that only read how a terminal is laid out, which a view share and
 * a link may make: without `pane.list` a viewer could not pick what to watch.
 * Everything else - input, history, settings, files - needs control.
 */
const VIEW_KINDS = new Set(["pane.list", "pane.inspect", "tab.list", "tab.inspect", "window.list", "window.inspect"]);

/** The roles a socket may take, by its `?role=`. */
const ROLES = new Set(["instance", "controller", "viewer"]);

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
    /**
     * Who watches each pane, by `instance|pane`: sockets here, and the nodes
     * whose sockets watch it when the terminal is held here. `holder` is the
     * node the watch was asked of when that is another one.
     */
    const watches = new Map();

    const watchKey = (instanceId, pane) => `${instanceId}|${pane}`;

    function watchEntry(instanceId, pane) {
        const key = watchKey(instanceId, pane);
        let entry = watches.get(key);
        if (!entry) {
            entry = {
                key,
                instanceId,
                pane,
                local: new Set(),
                remote: new Set(),
                holder: null,
                attached: false,
                tokens: TERMINAL_LIMITS.outputBurstBytes,
                refilledAt: now(),
                gap: false
            };
            watches.set(key, entry);
        }
        return entry;
    }

    /** Ask the terminal held here for a pane's output, once. */
    function attach(entry) {
        const instance = instances.get(entry.instanceId);
        if (!instance || instance.closed || entry.attached) return;
        entry.attached = true;
        send(instance, { type: "attach", pane: entry.pane });
    }

    /** Drop an entry nobody watches any more, telling whoever feeds it. */
    function settle(entry) {
        if (entry.local.size > 0 || entry.remote.size > 0) return;
        watches.delete(entry.key);
        const instance = instances.get(entry.instanceId);
        if (entry.attached && instance && !instance.closed) send(instance, { type: "detach", pane: entry.pane });
        if (entry.holder)
            void deps
                .app({
                    op: "watch",
                    node: entry.holder,
                    origin: deps.node,
                    instanceId: entry.instanceId,
                    pane: entry.pane,
                    on: false
                })
                .catch(() => null);
    }

    function unwatch(conn, key) {
        const entry = watches.get(key);
        conn.watching?.delete(key);
        if (!entry) return;
        entry.local.delete(conn);
        settle(entry);
    }

    /** A watch ends for everybody on it: the terminal left, or its holder said so. */
    function endWatch(entry, code) {
        watches.delete(entry.key);
        for (const conn of entry.local) {
            conn.watching?.delete(entry.key);
            send(conn, { type: "watch_end", instance: entry.instanceId, pane: entry.pane, code });
        }
        for (const node of entry.remote)
            void deps
                .app({
                    op: "stream",
                    node,
                    instanceId: entry.instanceId,
                    pane: entry.pane,
                    frame: { type: "watch_end", code }
                })
                .catch(() => null);
    }

    /** A frame of a pane's output, to its watchers here. */
    function fanOut(entry, frame) {
        for (const conn of entry.local) send(conn, frame);
    }

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
        for (const key of [...(conn.watching ?? [])]) unwatch(conn, key);
        if (conn.role === "instance" && conn.identity && instances.get(conn.identity.instanceId) === conn) {
            instances.delete(conn.identity.instanceId);
            for (const entry of [...watches.values()])
                if (entry.instanceId === conn.identity.instanceId && !entry.holder) endWatch(entry, "offline");
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
            // Whoever was watching through the socket it replaced keeps watching.
            for (const entry of watches.values()) {
                if (entry.instanceId !== id || entry.holder) continue;
                entry.attached = false;
                attach(entry);
            }
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
        if (frame.type === "output" && typeof frame.pane === "string" && typeof frame.data === "string") {
            const entry = watches.get(watchKey(conn.identity.instanceId, frame.pane));
            // Output nobody asked for is dropped rather than relayed.
            if (!entry || entry.holder) return;
            const at = now();
            entry.tokens = Math.min(
                TERMINAL_LIMITS.outputBurstBytes,
                entry.tokens + ((at - entry.refilledAt) / 1000) * TERMINAL_LIMITS.outputBytesPerSecond
            );
            entry.refilledAt = at;
            if (entry.tokens < frame.data.length) {
                entry.gap = true;
                return;
            }
            entry.tokens -= frame.data.length;
            const out = { type: "output", instance: entry.instanceId, pane: entry.pane, data: frame.data };
            if (entry.gap) out.gap = true;
            entry.gap = false;
            fanOut(entry, out);
            for (const node of entry.remote)
                void deps
                    .app({ op: "stream", node, instanceId: entry.instanceId, pane: entry.pane, frame: out })
                    .catch(() => null);
            return;
        }
        if (frame.type === "ping") send(conn, { type: "pong" });
    }

    /** Where a controller's or viewer's frame for `instanceId` goes, asked each time. */
    async function routeFor(conn, instanceId, need) {
        // A viewer's ticket names the one terminal it may reach.
        if (conn.role === "viewer" && conn.identity.bound !== instanceId) return { allowed: false, node: null };
        return deps
            .app({
                op: "route",
                userId: conn.identity.userId,
                keyId: conn.identity.keyId ?? null,
                linkId: conn.identity.linkId ?? null,
                instanceId,
                need
            })
            .catch(() => null);
    }

    async function onWatchFrame(conn, frame) {
        const instanceId = frame.instance;
        const pane = frame.pane;
        const key = watchKey(instanceId, pane);
        if (frame.type === "unwatch") {
            if (conn.watching?.has(key)) unwatch(conn, key);
            return;
        }
        const end = (code) => send(conn, { type: "watch_end", instance: instanceId, pane, code });
        if (conn.watching?.has(key)) return;
        if ((conn.watching?.size ?? 0) >= TERMINAL_LIMITS.watches) return end("busy");
        const route = await routeFor(conn, instanceId, "view");
        if (conn.closed) return;
        if (!route?.allowed) return end("not_found");
        if (!route.node) return end("offline");
        if (route.node === deps.node && !instances.has(instanceId)) return end("offline");
        const entry = watchEntry(instanceId, pane);
        if (entry.local.size >= TERMINAL_LIMITS.watchers) {
            settle(entry);
            return end("busy");
        }
        conn.watching ??= new Set();
        conn.watching.add(key);
        entry.local.add(conn);
        send(conn, { type: "watching", instance: instanceId, pane });
        if (route.node === deps.node) {
            attach(entry);
            return;
        }
        if (entry.holder) return;
        entry.holder = route.node;
        const sent = await deps
            .app({ op: "watch", node: route.node, origin: deps.node, instanceId, pane, on: true })
            .catch(() => null);
        if (!sent?.ok && watches.get(key) === entry) endWatch(entry, "offline");
    }

    async function onControllerFrame(conn, frame) {
        if (frame.type === "ping") {
            send(conn, { type: "pong" });
            return;
        }
        if (
            (frame.type === "watch" || frame.type === "unwatch") &&
            typeof frame.instance === "string" &&
            UUID.test(frame.instance) &&
            typeof frame.pane === "string" &&
            PANE.test(frame.pane)
        ) {
            await onWatchFrame(conn, frame);
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
        const kind = frame.envelope?.action?.kind;
        const route = await routeFor(conn, instanceId, VIEW_KINDS.has(kind) ? "view" : "control");
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

        if (!ROLES.has(role)) {
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
                    (role === "controller" ||
                        (role === "instance" && typeof identity.instanceId === "string") ||
                        (role === "viewer" && typeof identity.bound === "string"));
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
        if (path === "/terminal/watch") {
            const valid =
                typeof body?.instanceId === "string" &&
                typeof body.pane === "string" &&
                PANE.test(body.pane) &&
                typeof body.origin === "string" &&
                body.origin !== deps.node;
            if (!valid) return { status: 200, body: { held: false } };
            const key = watchKey(body.instanceId, body.pane);
            if (!body.on) {
                const entry = watches.get(key);
                if (entry) {
                    entry.remote.delete(body.origin);
                    settle(entry);
                }
                return { status: 200, body: { held: true } };
            }
            if (!instances.has(body.instanceId)) {
                void deps
                    .app({
                        op: "stream",
                        node: body.origin,
                        instanceId: body.instanceId,
                        pane: body.pane,
                        frame: { type: "watch_end", code: "offline" }
                    })
                    .catch(() => null);
                return { status: 200, body: { held: false } };
            }
            const entry = watchEntry(body.instanceId, body.pane);
            entry.remote.add(body.origin);
            attach(entry);
            return { status: 200, body: { held: true } };
        }
        if (path === "/terminal/stream") {
            const entry =
                typeof body?.instanceId === "string" && typeof body.pane === "string"
                    ? watches.get(watchKey(body.instanceId, body.pane))
                    : null;
            const frame = body?.frame;
            if (!entry || !entry.holder || !frame) return { status: 200, body: { delivered: false } };
            if (frame.type === "watch_end") {
                entry.holder = null;
                endWatch(entry, String(frame.code ?? "offline").slice(0, 40));
            } else if (frame.type === "output" && typeof frame.data === "string") {
                const out = { type: "output", instance: entry.instanceId, pane: entry.pane, data: frame.data };
                if (frame.gap) out.gap = true;
                fanOut(entry, out);
            }
            return { status: 200, body: { delivered: true } };
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
        // Every watch here, so a share withdrawn or a key revoked ends it too.
        const watching = [];
        for (const entry of watches.values())
            for (const conn of entry.local)
                watching.push({
                    conn,
                    key: entry.key,
                    userId: conn.identity.userId,
                    keyId: conn.identity.keyId ?? null,
                    linkId: conn.identity.linkId ?? null,
                    instanceId: entry.instanceId
                });
        if (held.length === 0 && watching.length === 0) return;
        const answer = await deps
            .app({
                op: "standing",
                instanceIds: held,
                watches: watching.map(({ userId, keyId, linkId, instanceId }) => ({ userId, keyId, linkId, instanceId }))
            })
            .catch(() => null);
        const ended = Array.isArray(answer?.ended) ? answer.ended : [];
        for (const id of ended) {
            const conn = typeof id === "string" ? instances.get(id) : null;
            if (conn) close(conn, TERMINAL_CLOSE.unauthorized, "signed out");
        }
        const withdrawn = Array.isArray(answer?.withdrawn) ? answer.withdrawn : [];
        for (const index of withdrawn) {
            const watch = Number.isInteger(index) ? watching[index] : null;
            if (!watch || !watch.conn.watching?.has(watch.key)) continue;
            const [instanceId, pane] = [watch.instanceId, watch.key.slice(watch.instanceId.length + 1)];
            unwatch(watch.conn, watch.key);
            send(watch.conn, { type: "watch_end", instance: instanceId, pane, code: "not_found" });
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
        watchers: (instanceId, pane) => {
            const entry = watches.get(watchKey(instanceId, pane));
            return entry ? entry.local.size + entry.remote.size : 0;
        },
        get size() {
            return instances.size;
        }
    };
}
