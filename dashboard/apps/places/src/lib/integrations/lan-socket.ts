/**
 * A WebSocket to a device, a bridge or a hub somebody pointed Polaris at: the
 * channel a make that pushes its changes keeps open (`device-push.ts`).
 *
 * The same care as `lan-http`, for the same reasons: this machine, link-local
 * and reserved ranges are never dialed, by address or by what a name resolves
 * to; a hub's own certificate is pinned and checked on the socket before the
 * upgrade request - which carries its token - is written; a certificate a
 * public authority signed is checked against the system's. What arrives is
 * capped per message.
 *
 * Server-only.
 */

import WebSocket from "ws";
import { isIP } from "node:net";
import { DriverError } from "../drivers/contract";
import { refusal, secureSocket, type LanTrust } from "./lan-http";
import { forbiddenAddress, forbiddenError, guardedLookup } from "./lan-address";

/** How long the connection and its upgrade are given. */
const OPEN_MS = 10_000;

/** How often a quiet channel is asked whether it is still there; one that has
 *  not answered the last ask by the next is taken as gone. */
const PING_MS = 30_000;

/** One message from a hub is an event about a device; a whole house's state is
 *  read over HTTP, never pushed. */
const MAX_MESSAGE_BYTES = 1_000_000;

/** What arrived before anybody read the socket: a device that speaks first
 *  (Home Assistant asks for its token straight away) says it in the same
 *  packet as the upgrade, before `open` has been answered. */
const EARLY = new WeakMap<WebSocket, string[]>();

function textOf(data: WebSocket.RawData): string {
    return Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data as Buffer).toString("utf8");
}

export interface LanSocketOptions {
    /** `ws:` or `wss:`. */
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    /** Required for `wss:`, as `lanRequest` requires it for https. */
    readonly trust?: LanTrust | "system";
    readonly timeoutMs?: number;
    /** What to say when the device answers the upgrade with 401 or 403: the
     *  make's own sentence for a token it no longer takes. */
    readonly signInRefused?: string;
}

/** An open WebSocket, or a refusal in a sentence. */
export async function openLanSocket(options: LanSocketOptions): Promise<WebSocket> {
    const url = new URL(options.url);
    const secure = url.protocol === "wss:";
    if (!secure && url.protocol !== "ws:") {
        throw new DriverError("The device could not be reached.", "unreachable");
    }
    if (secure && !options.trust) {
        throw new DriverError(
            "The device's certificate is not one Polaris can trust, so nothing was sent to it.",
            "refused"
        );
    }
    const timeoutMs = options.timeoutMs ?? OPEN_MS;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (secure ? 443 : 80);
    if (isIP(host) && forbiddenAddress(host)) throw forbiddenError();

    const trust = options.trust;
    // A pinned or private-authority certificate is checked on a socket of our
    // own, before the upgrade with its token is written to it.
    const socket =
        secure && trust && trust !== "system"
            ? await secureSocket(host, port, trust, timeoutMs)
            : null;

    return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url, {
            headers: { ...(options.headers ?? {}) },
            handshakeTimeout: timeoutMs,
            maxPayload: MAX_MESSAGE_BYTES,
            followRedirects: false,
            perMessageDeflate: false,
            ...(socket ? { createConnection: () => socket } : { lookup: guardedLookup })
        });
        const early: string[] = [];
        EARLY.set(ws, early);
        ws.on("message", (data: WebSocket.RawData, binary: boolean) => {
            if (!binary && EARLY.get(ws) === early) early.push(textOf(data));
        });
        const fail = (error: unknown) => {
            ws.removeAllListeners("open");
            ws.terminate();
            socket?.destroy();
            reject(
                error instanceof DriverError
                    ? error
                    : refusal(error as NodeJS.ErrnoException)
            );
        };
        ws.once("open", () => {
            ws.removeAllListeners("unexpected-response");
            ws.removeListener("error", fail);
            resolve(ws);
        });
        ws.once("error", fail);
        ws.once("unexpected-response", (_request, response) => {
            const status = response.statusCode ?? 0;
            fail(
                status === 401 || status === 403
                    ? new DriverError(
                              options.signInRefused ?? "The device refused the sign-in.",
                              "unauthorized"
                          )
                    : new DriverError("The device would not keep a connection open.", "refused")
            );
        });
    });
}

/**
 * Every message until the socket closes, as text. Resolves when it closes -
 * either side, `signal`, or a ping left unanswered (a hub that lost power
 * closes nothing) - and never rejects: a channel that drops is opened again by
 * whoever opened it.
 */
export function eachMessage(
    ws: WebSocket,
    onMessage: (text: string) => void,
    signal: AbortSignal
): Promise<void> {
    return new Promise((resolve) => {
        let answered = true;
        const heartbeat = setInterval(() => {
            if (!answered) {
                close();
                return;
            }
            answered = false;
            ws.ping();
        }, PING_MS);
        heartbeat.unref?.();
        const close = () => {
            clearInterval(heartbeat);
            signal.removeEventListener("abort", close);
            ws.removeAllListeners("message");
            ws.terminate();
            resolve();
        };
        const early = EARLY.get(ws) ?? [];
        EARLY.delete(ws);
        ws.removeAllListeners("message");
        if (signal.aborted) {
            close();
            return;
        }
        signal.addEventListener("abort", close);
        ws.on("message", (data: WebSocket.RawData, binary: boolean) => {
            if (!binary) onMessage(textOf(data));
        });
        ws.on("pong", () => {
            answered = true;
        });
        ws.once("close", close);
        ws.once("error", close);
        for (const text of early) onMessage(text);
        // Closed before it was read: what it said first is all there is.
        if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) close();
    });
}
