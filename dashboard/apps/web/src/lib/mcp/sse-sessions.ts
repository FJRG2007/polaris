/**
 * The legacy HTTP+SSE transport (MCP 2024-11-05), for clients that never
 * learned Streamable HTTP.
 *
 * Such a client opens a GET stream, is told on it where to POST, and reads every
 * reply off the stream rather than off the POST. So unlike `/api/mcp`, this one
 * has to remember something between requests: which stream a POST belongs to.
 * That memory is this module - a map from the session id the SDK's transport
 * mints to the open stream and the credential that opened it.
 *
 * The wire format is the official SDK's `SSEServerTransport` (the `endpoint`
 * event, the `sessionId` it appends, the `message` framing). That class writes
 * to a Node `ServerResponse`; a route handler answers with a web stream, so
 * `streamSink` hands it the four methods it calls and nothing else.
 *
 * In memory, because the dashboard is one process: a POST always reaches the
 * process holding its stream. A session dies with its stream, and with the
 * process, and a client that loses one opens another.
 */

import { createHash } from "node:crypto";
import { SSE_PATH } from "@/lib/mcp/oauth/urls";
import type { ServerResponse } from "node:http";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/** Streams one credential may hold open at once: a client or two per
 *  machine, and not a loop that never closes what it opened. */
export const STREAMS_PER_CREDENTIAL = 4;

/** Streams the whole instance holds open at once. */
export const STREAMS_MAX = 500;

/** How often an idle stream says something, so a proxy does not drop it. */
const KEEPALIVE_MS = 25_000;

/** How long one stream stays open. Every POST is authorized on its own, so
 *  this bounds what an abandoned stream holds, not what a token may do. */
const LIFETIME_MS = 12 * 60 * 60 * 1000;

interface Session {
    owner: string;
    transport: SSEServerTransport;
}

const sessions = new Map<string, Session>();

/**
 * Who a bearer credential belongs to, as a key a session is bound to.
 *
 * An OAuth access token is replaced every hour while its grant lives on, so the
 * grant is the owner: a client that refreshes keeps its stream. Any other
 * credential (an API key, an agent session's token) does not change, so it is
 * its own owner, kept as a hash rather than as the secret.
 */
export function ownerKey(token: string, grantId: string | null): string {
    if (grantId) return `grant:${grantId}`;
    return `token:${createHash("sha256").update(token).digest("hex")}`;
}

/** The bearer token in an Authorization header, or null. */
export function bearerToken(header: string | null): string | null {
    const [scheme, ...rest] = (header ?? "").trim().split(/\s+/);
    if (scheme?.toLowerCase() !== "bearer") return null;
    const token = rest.join("");
    return token || null;
}

/**
 * The slice of `ServerResponse` that `SSEServerTransport` uses, writing into a
 * web stream. Headers are the route's to set on its Response, so `writeHead`
 * only has to not fail.
 */
function streamSink(
    controller: ReadableStreamDefaultController<Uint8Array>,
    onClose: Array<() => void>
): ServerResponse {
    const encoder = new TextEncoder();
    const sink = {
        writeHead: () => sink,
        write: (chunk: string) => {
            controller.enqueue(encoder.encode(chunk));
            return true;
        },
        end: () => {
            try {
                controller.close();
            } catch {
                // Already closed by the client going away.
            }
            return sink;
        },
        on: (event: string, listener: () => void) => {
            if (event === "close") onClose.push(listener);
            return sink;
        }
    };
    return sink as unknown as ServerResponse;
}

/** Why a stream was not opened. */
export type OpenRefusal = "credential-full" | "instance-full";

/**
 * Open a stream for `owner`, or say why not.
 *
 * The stream starts with the SDK's `endpoint` event, keeps itself alive with an
 * SSE comment, and forgets its session the moment it closes - whichever side
 * closes it.
 */
export async function openSession(
    owner: string,
    signal: AbortSignal
): Promise<{ sessionId: string; body: ReadableStream<Uint8Array> } | OpenRefusal> {
    if (sessions.size >= STREAMS_MAX) return "instance-full";
    let held = 0;
    for (const session of sessions.values()) if (session.owner === owner) held++;
    if (held >= STREAMS_PER_CREDENTIAL) return "credential-full";

    const closers: Array<() => void> = [];
    let transport: SSEServerTransport | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let lifetime: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
        if (keepalive) clearInterval(keepalive);
        if (lifetime) clearTimeout(lifetime);
        keepalive = lifetime = null;
        if (transport) sessions.delete(transport.sessionId);
        for (const close of closers.splice(0)) close();
    };

    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            const sink = streamSink(controller, closers);
            transport = new SSEServerTransport(SSE_PATH, sink);
            sessions.set(transport.sessionId, { owner, transport });
            await transport.start();
            // The transport registered its own close listener on the sink; this
            // one is ours, and both run when the stream ends.
            closers.push(() => sink.end());
            const ping = new TextEncoder().encode(":\n\n");
            keepalive = setInterval(() => {
                try {
                    controller.enqueue(ping);
                } catch {
                    finish();
                }
            }, KEEPALIVE_MS);
            lifetime = setTimeout(finish, LIFETIME_MS);
            signal.addEventListener("abort", finish, { once: true });
            // A client that left while the stream was starting fired no event.
            if (signal.aborted) finish();
        },
        cancel() {
            finish();
        }
    });

    // `start` runs synchronously up to its first await, so the session exists
    // once the stream does.
    const id = (transport as SSEServerTransport | null)?.sessionId;
    if (!id) throw new Error("The SSE transport did not start");
    return { sessionId: id, body };
}

/** Whether `sessionId` is an open stream that `owner` opened. A stream
 *  somebody else opened is reported as not there at all. */
export function ownsSession(sessionId: string, owner: string): boolean {
    return sessions.get(sessionId)?.owner === owner;
}

/**
 * Put replies on a session's stream. False when the stream is gone, which a
 * client learns from the POST rather than by waiting on a reply that will
 * never come.
 */
export async function deliver(sessionId: string, messages: JSONRPCMessage[]): Promise<boolean> {
    const session = sessions.get(sessionId);
    if (!session) return false;
    try {
        for (const message of messages) await session.transport.send(message);
        return true;
    } catch {
        sessions.delete(sessionId);
        return false;
    }
}

/** How many streams are open; for tests. */
export function openSessionCount(): number {
    return sessions.size;
}
