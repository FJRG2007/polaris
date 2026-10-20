/**
 * The only way a connector reaches the network: `configuredRequest`
 * (`lib/safe-fetch.ts`), so a server's address - and every address it points
 * Polaris at, its authorization server and token endpoint included - is
 * checked against the private ranges at every connection, with no redirect
 * followed, a timeout, and a byte ceiling on what comes back.
 *
 * The ceiling counts the body as it streams, so a server that answers with an
 * event stream is still read as one, and one that never stops sending is cut
 * off at `maxBytes` instead of filling memory.
 *
 * Server-only.
 */

import { configuredRequest } from "@/lib/safe-fetch";
import type { ConnectorFetch } from "@/lib/polar/connectors/oauth";

/** What one connector request may bring back. */
export const RESPONSE_MAX = 4 * 1024 * 1024;

export interface ConnectorFetchOptions {
    /** Whether a private address is allowed: the administrator's decision. */
    allowPrivate: boolean;
    timeoutMs?: number;
    maxBytes?: number;
    /** False for a Streamable HTTP client: the optional listening stream
     *  (`GET` with `text/event-stream`) is answered 405 here, which the spec
     *  lets a server answer, so a per-turn client never holds one open. */
    listen?: boolean;
}

/** A body that errors once more than `max` bytes went through it. */
export function cappedBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
    let seen = 0;
    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                seen += chunk.byteLength;
                if (seen > max) {
                    controller.error(new Error(`the answer passed ${max} bytes`));
                    return;
                }
                controller.enqueue(chunk);
            }
        })
    );
}

export function connectorFetch(options: ConnectorFetchOptions): ConnectorFetch {
    const max = options.maxBytes ?? RESPONSE_MAX;
    return async (address, init = {}) => {
        const method = (init.method ?? "GET").toUpperCase();
        const accept = new Headers(init.headers).get("accept") ?? "";
        if (options.listen === false && method === "GET" && accept.includes("text/event-stream")) {
            return new Response(null, { status: 405 });
        }
        const response = await configuredRequest(
            address,
            { ...init, timeoutMs: options.timeoutMs ?? 30_000 },
            { allowPrivate: options.allowPrivate }
        );
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > max) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`the answer passed ${max} bytes`);
        }
        if (!response.body) return response;
        return new Response(cappedBody(response.body, max), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    };
}
