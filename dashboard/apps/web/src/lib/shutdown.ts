/**
 * The moment this container is told to stop - an update replacing it, or the
 * host restarting it.
 *
 * On SIGTERM Next.js stops accepting connections and waits for the ones still
 * open before it exits. A live stream (the chat, notifications, a call's room)
 * never finishes on its own, so without this the old container sits out the
 * whole stop timeout with its listener closed while the edge keeps sending it
 * requests, and those fail. Streams opened through `untilShutdown` end the
 * moment the signal arrives instead; the browser's EventSource reconnects, and
 * lands on the container that replaced this one. Ordinary requests in flight
 * are left alone and finish, which is Next.js's own drain.
 *
 * This only listens: Next.js keeps its own SIGTERM handler, which is what
 * exits, so adding a listener here does not hold the process up.
 */

let stopping: AbortController | null = null;

/** Aborts once this process has been asked to stop. */
export function shutdownSignal(): AbortSignal {
    if (!stopping) {
        stopping = new AbortController();
        process.once("SIGTERM", beginShutdown);
    }
    return stopping.signal;
}

/** What SIGTERM does here: everything waiting on `shutdownSignal` ends. */
export function beginShutdown(): void {
    shutdownSignal();
    stopping?.abort();
}

/** Whether this process has been asked to stop. */
export function shuttingDown(): boolean {
    return stopping?.signal.aborted ?? false;
}

/** A request's own signal that also aborts when this process is asked to stop,
 *  for a response that streams until somebody closes it. */
export function untilShutdown(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, shutdownSignal()]);
}
