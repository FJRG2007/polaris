/**
 * The relay's side of a runner connection, independent of any socket library.
 *
 * The WebSocket sidecar (`apps/web/ws-server.mjs`) hands every runner socket to
 * one `RunnerRelay`, which owns what the protocol promises (see
 * `runner-protocol.ts`): the credential is checked before anything else is
 * read, `hello` must arrive in time and name a protocol this server speaks,
 * one runner holds one live connection (a newer one replaces the older), a
 * silent connection is dropped, a flood is cut off, and terminal output is
 * dropped for a viewer that cannot keep up rather than buffered without end.
 *
 * What a runner says that the dashboard has to act on goes to `deliver`, which
 * the sidecar points at the web app's loopback route; what the dashboard wants
 * a runner to do arrives through `send`. Terminal output never leaves the
 * sidecar: it goes straight to the viewers attached here.
 *
 * Pure apart from the timers the caller drives (`sweep`), so every rule here is
 * asserted with a fake socket.
 */

import {
    RUNNER_CLOSE,
    RUNNER_LIMITS,
    RUNNER_PROTOCOL_VERSION,
    encodeServerFrame,
    parseRunnerFrame,
    protocolCompatible,
    type RunnerMessage,
    type ServerCommand
} from "./runner-protocol.js";

/** The part of a WebSocket the relay uses. `ws`'s `WebSocket` satisfies it. */
export interface RelaySocket {
    readonly bufferedAmount: number;
    send(data: string): void;
    close(code: number, reason: string): void;
}

/** Who a credential belongs to. */
export interface RunnerIdentity {
    readonly runnerId: string;
    readonly userId: string;
}

export interface RelayDeps {
    /** The runner the credential names, or null for a wrong or revoked one. */
    readonly authenticate: (token: string) => Promise<RunnerIdentity | null>;
    /** Hand a runner's frame to the dashboard. May answer with one frame for
     *  the runner (a permission decision). */
    readonly deliver: (runner: RunnerIdentity, message: RunnerMessage) => Promise<ServerCommand | null>;
    /** The runner came online here, or went away from here. */
    readonly presence: (runner: RunnerIdentity, online: boolean) => Promise<void>;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
}

/** A viewer of one session's terminal, attached in this process. */
export interface TerminalViewer {
    readonly bufferedAmount: number;
    write(data: Buffer): void;
}

interface Connection {
    readonly socket: RelaySocket;
    identity: RunnerIdentity | null;
    greeted: boolean;
    readonly openedAt: number;
    lastHeard: number;
    tokens: number;
    refilledAt: number;
    closed: boolean;
}

export class RunnerRelay {
    private readonly deps: RelayDeps;
    private readonly now: () => number;
    private readonly connections = new Set<Connection>();
    /** The one live, greeted connection of each runner. */
    private readonly live = new Map<string, Connection>();
    /** Terminal viewers by `runnerId:sessionId`. */
    private readonly viewers = new Map<string, Set<TerminalViewer>>();

    constructor(deps: RelayDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }

    /** How many runners are live here. */
    get size(): number {
        return this.live.size;
    }

    /** Whether this runner's live connection is in this process. */
    holds(runnerId: string): boolean {
        return this.live.has(runnerId);
    }

    /**
     * Take a new socket. Returns the handlers the caller wires to the socket's
     * `message` and `close` events. The credential is checked first; nothing a
     * socket sends before that is read.
     */
    accept(socket: RelaySocket, token: string): { message: (raw: string) => void; close: () => void } {
        const at = this.now();
        const connection: Connection = {
            socket,
            identity: null,
            greeted: false,
            openedAt: at,
            lastHeard: at,
            tokens: RUNNER_LIMITS.burst,
            refilledAt: at,
            closed: false
        };
        this.connections.add(connection);
        const pending: string[] = [];
        let authed = false;
        void (async () => {
            const identity = token ? await this.deps.authenticate(token).catch(() => null) : null;
            if (connection.closed) return;
            if (!identity) return this.shut(connection, RUNNER_CLOSE.unauthorized, "unauthorized");
            connection.identity = identity;
            authed = true;
            for (const raw of pending.splice(0)) await this.receive(connection, raw);
        })();
        return {
            message: (raw) => {
                if (connection.closed) return;
                // Held, bounded, until the credential is checked.
                if (!authed) {
                    if (pending.length < 4) pending.push(raw);
                    return;
                }
                void this.receive(connection, raw);
            },
            close: () => this.forget(connection)
        };
    }

    /** Send a dashboard command to a runner live here. False when it is not
     *  here, or is too far behind to take a terminal keystroke. */
    send(runnerId: string, command: ServerCommand): boolean {
        const connection = this.live.get(runnerId);
        if (!connection || connection.closed) return false;
        if (
            connection.socket.bufferedAmount > RUNNER_LIMITS.bufferedBytes &&
            (command.type === "terminal.input" || command.type === "terminal.resize")
        )
            return false;
        connection.socket.send(encodeServerFrame(command));
        return true;
    }

    /** Close a runner's connection here, e.g. when it was revoked. */
    close(runnerId: string, code: number = RUNNER_CLOSE.revoked): boolean {
        const connection = this.live.get(runnerId);
        if (!connection) return false;
        this.shut(connection, code, "closed by the server");
        return true;
    }

    /** Watch one session's terminal output from a runner live here. Returns
     *  the unsubscribe. */
    watchTerminal(runnerId: string, sessionId: string, viewer: TerminalViewer): () => void {
        const key = `${runnerId}:${sessionId}`;
        let set = this.viewers.get(key);
        if (!set) {
            set = new Set();
            this.viewers.set(key, set);
        }
        set.add(viewer);
        return () => {
            const current = this.viewers.get(key);
            current?.delete(viewer);
            if (current && current.size === 0) this.viewers.delete(key);
        };
    }

    /** Drop connections that never greeted in time or went silent. Call every
     *  few seconds. */
    sweep(): void {
        const at = this.now();
        for (const connection of this.connections) {
            if (!connection.greeted && at - connection.openedAt > RUNNER_LIMITS.helloTimeoutMs)
                this.shut(connection, RUNNER_CLOSE.protocol, "no hello");
            else if (connection.greeted && at - connection.lastHeard > RUNNER_LIMITS.heartbeatTimeoutMs)
                this.shut(connection, RUNNER_CLOSE.heartbeat, "heartbeat timeout");
        }
    }

    private async receive(connection: Connection, raw: string): Promise<void> {
        if (connection.closed || !connection.identity) return;
        if (!this.take(connection)) return this.shut(connection, RUNNER_CLOSE.rateLimited, "rate limited");
        connection.lastHeard = this.now();
        const parsed = parseRunnerFrame(raw);
        if (!parsed.ok) {
            if (parsed.code === "too_large") return this.shut(connection, RUNNER_CLOSE.tooLarge, "frame too large");
            this.reply(connection, { type: "error", code: parsed.code, message: parsed.detail });
            return;
        }
        const message = parsed.message;
        const identity = connection.identity;
        if (!connection.greeted) {
            if (message.type !== "hello") return this.shut(connection, RUNNER_CLOSE.protocol, "hello first");
            if (!protocolCompatible(message.protocol))
                return this.shut(connection, RUNNER_CLOSE.protocol, `server speaks ${RUNNER_PROTOCOL_VERSION}`);
            connection.greeted = true;
            const previous = this.live.get(identity.runnerId);
            this.live.set(identity.runnerId, connection);
            if (previous && previous !== connection) this.shut(previous, RUNNER_CLOSE.replaced, "replaced");
            this.reply(connection, {
                type: "welcome",
                runnerId: identity.runnerId,
                protocol: RUNNER_PROTOCOL_VERSION,
                limits: {
                    frameBytes: RUNNER_LIMITS.frameBytes,
                    promptChars: RUNNER_LIMITS.promptChars,
                    heartbeatMs: RUNNER_LIMITS.heartbeatMs,
                    heartbeatTimeoutMs: RUNNER_LIMITS.heartbeatTimeoutMs
                }
            });
            await this.deps.presence(identity, true).catch(() => undefined);
            await this.forward(connection, message);
            return;
        }
        if (message.type === "hello") return;
        if (message.type === "terminal.output") {
            this.fanOut(identity.runnerId, message.sessionId, message.data);
            return;
        }
        if (message.type === "heartbeat") this.reply(connection, { type: "heartbeat.ack" });
        await this.forward(connection, message);
    }

    private async forward(connection: Connection, message: RunnerMessage): Promise<void> {
        const identity = connection.identity;
        if (!identity) return;
        try {
            const answer = await this.deps.deliver(identity, message);
            if (answer && !connection.closed) this.reply(connection, answer);
        } catch (caught) {
            this.deps.log?.(`runner ${identity.runnerId}: ${message.type} not delivered: ${String(caught)}`);
            if (message.type !== "heartbeat")
                this.reply(connection, { type: "error", code: "unavailable", message: "Polaris could not take that just now" });
        }
    }

    private fanOut(runnerId: string, sessionId: string, base64: string): void {
        const set = this.viewers.get(`${runnerId}:${sessionId}`);
        if (!set || set.size === 0) return;
        const bytes = Buffer.from(base64, "base64");
        for (const viewer of set) {
            // A viewer that is this far behind loses output rather than
            // making the sidecar hold it; the screen redraws on the next frame.
            if (viewer.bufferedAmount > RUNNER_LIMITS.bufferedBytes) continue;
            viewer.write(bytes);
        }
    }

    /** Token bucket: `framesPerSecond`, bursting to `burst`. */
    private take(connection: Connection): boolean {
        const at = this.now();
        const refill = ((at - connection.refilledAt) / 1000) * RUNNER_LIMITS.framesPerSecond;
        connection.tokens = Math.min(RUNNER_LIMITS.burst, connection.tokens + refill);
        connection.refilledAt = at;
        if (connection.tokens < 1) return false;
        connection.tokens -= 1;
        return true;
    }

    private reply(connection: Connection, command: ServerCommand): void {
        if (connection.closed) return;
        try {
            connection.socket.send(encodeServerFrame(command));
        } catch (caught) {
            this.deps.log?.(`runner reply failed: ${String(caught)}`);
        }
    }

    private shut(connection: Connection, code: number, reason: string): void {
        if (connection.closed) return;
        try {
            connection.socket.close(code, reason);
        } catch {
            // Already gone.
        }
        this.forget(connection);
    }

    private forget(connection: Connection): void {
        const wasLive =
            connection.identity !== null && this.live.get(connection.identity.runnerId) === connection;
        connection.closed = true;
        this.connections.delete(connection);
        if (wasLive && connection.identity) {
            this.live.delete(connection.identity.runnerId);
            void this.deps.presence(connection.identity, false).catch(() => undefined);
        }
    }
}
