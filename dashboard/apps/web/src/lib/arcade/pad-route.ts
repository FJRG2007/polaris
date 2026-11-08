/**
 * What every phone-pad route shares: the signed-in reader who may play games,
 * and the event stream both ends of a pad listen on.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import { backgroundUser, sessionCan, type SessionUser } from "@/lib/session";

/** Idle keep-alive, so a proxy does not drop a quiet stream. */
const HEARTBEAT_MS = 25_000;

type ErrorKey = "unauthorized" | "forbidden" | "notFound" | "invalidRequest" | "tooManyRequests";

export async function padError(key: ErrorKey, status: number): Promise<Response> {
    return Response.json({ error: (await readerWords("api"))(`errors.${key}`) }, { status });
}

/** The reader, or the response that refuses them. */
export async function padReader(): Promise<SessionUser | Response> {
    const user = await backgroundUser();
    if (!user) return padError("unauthorized", 401);
    if (!(await sessionCan(user, "arcade.open"))) return padError("forbidden", 403);
    return user;
}

/**
 * An event stream fed by `subscribe`, which hands back its unsubscribe, or null
 * when there is nothing to listen to (a 404, so EventSource stops retrying).
 */
export async function padStream<T>(
    request: Request,
    subscribe: (send: (event: T) => void, end: () => void) => (() => void) | null
): Promise<Response> {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let cleanup: (() => void) | null = null;
    let closed = false;
    const end = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        cleanup?.();
        try {
            controller?.close();
        } catch {
            // Already closed by the client
        }
    };
    const write = (text: string) => {
        if (closed || !controller) return;
        try {
            controller.enqueue(encoder.encode(text));
        } catch {
            end();
        }
    };
    const unsubscribe = subscribe((event) => write(`data: ${JSON.stringify(event)}\n\n`), end);
    if (!unsubscribe) return padError("notFound", 404);
    cleanup = unsubscribe;
    const stream = new ReadableStream<Uint8Array>({
        start(opened) {
            controller = opened;
            write(": open\n\n");
            heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
        },
        cancel: end
    });
    request.signal.addEventListener("abort", end);
    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        }
    });
}
