/**
 * The runner's one connection to its Polaris (`docs/runner-protocol.md`).
 *
 * It dials `RUNNER_SOCKET_PATH` with the paired credential as a Bearer token,
 * says `hello`, answers `welcome` with `capabilities`, sends a `heartbeat`
 * every `heartbeatMs`, and hands every other server frame to `onCommand`. A
 * dropped connection is dialled again on the same backoff the app uses to get
 * back to a restarting server (`reconnect.ts`); the close codes that say
 * "do not come back with this" stop it instead.
 *
 * Pure, with no `electron` import: the socket, the timers and the clock are
 * handed in, so the whole rhythm is tested with a fake socket.
 */

import { reconnectDelay } from "../reconnect";
import * as protocol from "../../../../dashboard/packages/core/src/runner-protocol";

/** What the runner sends, minus the envelope. */
export type RunnerFrame = protocol.RunnerMessage extends infer M ? (M extends { v: number; } ? Omit<M, "v"> : never) : never;
export type ServerFrame = protocol.ServerMessage;

/** The part of a WHATWG `WebSocket` this uses, so Node's own and a fake fit. */
export interface RunnerSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown; }) => void) | null;
    onclose: ((event: { code: number; }) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

/** Where the connection stands, for the screen. */
export type RunnerState =
    | "connecting"
    | "online"
    | "offline"
    /** The credential was refused or the computer removed: pair again. */
    | "unpaired"
    /** The server speaks a protocol this desktop does not: update. */
    | "outdated"
    /** Another copy of this runner took over. */
    | "replaced"
    | "stopped";

export interface ConnectionOptions {
    /** The Polaris origin, `https://...`. */
    readonly server: string;
    readonly token: string;
    readonly runnerVersion: string;
    readonly openSocket: (url: string, headers: Record<string, string>) => RunnerSocket;
    /** The `capabilities` frame, built fresh on every connection. */
    readonly capabilities: () => Promise<Omit<protocol.RunnerCapabilities, "v">>;
    /** The sessions held right now, for `heartbeat`. */
    readonly sessions: () => string[];
    readonly onCommand: (frame: ServerFrame) => void;
    readonly onState?: (state: RunnerState) => void;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
    readonly log?: (message: string) => void;
}

const OPEN = 1;
/** The pause after a rate-limit close, longer than the first backoff step. */
const RATE_LIMIT_PAUSE_MS = 30_000;

/** The socket address for a Polaris origin. */
export function runnerSocketUrl(server: string): string {
    const url = new URL(protocol.RUNNER_SOCKET_PATH, server);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    return url.toString();
}

/** What a close code means for this runner. Pure, for the tests. */
export function afterClose(code: number): { state: RunnerState; retry: boolean; pauseMs?: number; } {
    switch (code) {
        case protocol.RUNNER_CLOSE.unauthorized:
        case protocol.RUNNER_CLOSE.revoked:
            return { state: "unpaired", retry: false };
        case protocol.RUNNER_CLOSE.protocol:
            return { state: "outdated", retry: false };
        case protocol.RUNNER_CLOSE.replaced:
            return { state: "replaced", retry: false };
        case protocol.RUNNER_CLOSE.rateLimited:
            return { state: "offline", retry: true, pauseMs: RATE_LIMIT_PAUSE_MS };
        default:
            return { state: "offline", retry: true };
    }
}

export class RunnerConnection {
    #socket: RunnerSocket | null = null;
    #state: RunnerState = "stopped";
    #attempt = 0;
    #retry: unknown = null;
    #beat: unknown = null;
    #stopped = true;
    #heartbeatMs: number = protocol.RUNNER_LIMITS.heartbeatMs;
    #frameBytes: number = protocol.RUNNER_LIMITS.frameBytes;
    readonly #setTimer: (run: () => void, ms: number) => unknown;
    readonly #clearTimer: (handle: unknown) => void;

    constructor(private readonly options: ConnectionOptions) {
        this.#setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
        this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    get state(): RunnerState {
        return this.#state;
    }

    start(): void {
        if (!this.#stopped) return;
        this.#stopped = false;
        this.#attempt = 0;
        this.#dial();
    }

    stop(): void {
        this.#stopped = true;
        this.#clearTimers();
        const socket = this.#socket;
        this.#socket = null;
        if (socket) {
            socket.onclose = null;
            socket.close(1000, "stopped");
        }
        this.#setState("stopped");
    }

    /** Send one frame. False when there is no live connection or the frame is
     *  larger than the server accepts; such a frame is dropped, never split. */
    send(frame: RunnerFrame): boolean {
        const socket = this.#socket;
        if (!socket || socket.readyState !== OPEN || this.#state !== "online") return false;
        const text = JSON.stringify({ v: protocol.RUNNER_PROTOCOL_VERSION, ...frame });
        if (Buffer.byteLength(text) > this.#frameBytes) {
            this.options.log?.(`runner: dropped a ${frame.type} frame larger than the limit`);
            return false;
        }
        socket.send(text);
        return true;
    }

    #setState(state: RunnerState): void {
        if (this.#state === state) return;
        this.#state = state;
        this.options.onState?.(state);
    }

    #clearTimers(): void {
        if (this.#retry !== null) this.#clearTimer(this.#retry);
        if (this.#beat !== null) this.#clearTimer(this.#beat);
        this.#retry = null;
        this.#beat = null;
    }

    #dial(): void {
        if (this.#stopped) return;
        this.#setState("connecting");
        let socket: RunnerSocket;
        try {
            socket = this.options.openSocket(runnerSocketUrl(this.options.server), { Authorization: `Bearer ${this.options.token}` });
        } catch (error) {
            this.options.log?.(`runner: could not open the socket: ${String(error)}`);
            this.#scheduleRetry();
            return;
        }
        this.#socket = socket;
        socket.onopen = () => {
            socket.send(
                JSON.stringify({
                    v: protocol.RUNNER_PROTOCOL_VERSION,
                    type: "hello",
                    runnerVersion: this.options.runnerVersion,
                    protocol: { min: protocol.RUNNER_PROTOCOL_VERSION, max: protocol.RUNNER_PROTOCOL_VERSION }
                })
            );
        };
        socket.onmessage = (event) => {
            if (typeof event.data !== "string") return;
            void this.#receive(socket, event.data);
        };
        socket.onerror = () => undefined;
        socket.onclose = (event) => {
            if (this.#socket !== socket) return;
            this.#socket = null;
            this.#clearTimers();
            const next = afterClose(event.code);
            this.#setState(next.state);
            if (next.retry) this.#scheduleRetry(next.pauseMs);
            else this.#stopped = true;
        };
    }

    #scheduleRetry(pauseMs?: number): void {
        if (this.#stopped) return;
        this.#setState("offline");
        const wait = Math.max(pauseMs ?? 0, reconnectDelay(this.#attempt));
        this.#attempt += 1;
        this.#retry = this.#setTimer(() => {
            this.#retry = null;
            this.#dial();
        }, wait);
    }

    async #receive(socket: RunnerSocket, raw: string): Promise<void> {
        const parsed = protocol.parseServerFrame(raw);
        if (!parsed.ok) {
            this.options.log?.(`runner: unreadable frame (${parsed.code}): ${parsed.detail}`);
            return;
        }
        const message = parsed.message;
        if (message.type === "welcome") {
            this.#attempt = 0;
            this.#heartbeatMs = message.limits.heartbeatMs;
            this.#frameBytes = message.limits.frameBytes;
            this.#setState("online");
            const capabilities = await this.options.capabilities();
            if (this.#socket !== socket) return;
            this.send({ ...capabilities, type: "capabilities" });
            this.#heartbeat();
            return;
        }
        if (message.type === "heartbeat.ack") return;
        if (message.type === "error") {
            this.options.log?.(`runner: server said ${message.code}: ${message.message}`);
            return;
        }
        this.options.onCommand(message);
    }

    #heartbeat(): void {
        this.#beat = this.#setTimer(() => {
            this.#beat = null;
            if (this.#state !== "online") return;
            this.send({ type: "heartbeat", sessions: this.options.sessions().slice(0, protocol.RUNNER_LIMITS.sessions) });
            this.#heartbeat();
        }, this.#heartbeatMs);
    }
}
