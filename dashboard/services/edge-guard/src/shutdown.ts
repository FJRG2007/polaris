/**
 * Leaving without dropping a request.
 *
 * An update replaces this container by starting the new one beside it and only then
 * stopping this one (`roll_over` in scripts/update.sh). Both answer to the same network
 * alias while they overlap, so the edge can reach either, and the stop is the only
 * moment a request could still be lost - one already in flight here, or one sent down
 * a kept-alive connection the edge is still holding to this container.
 *
 * So a stop is not an exit. For `lingerMs` this keeps accepting and answering, but
 * every response says `Connection: close`: whatever the edge is holding to this
 * container is handed back after its next answer, and its next request dials again -
 * which the alias now also answers from the new container. Then the listeners close
 * (a dial to this address is refused, and the edge's resolver moves to the next one),
 * idle connections are dropped, and the process waits for what is still in flight.
 * `deadlineMs` bounds that wait under docker's own stop timeout: a WebSocket spliced
 * through the proxy never finishes on its own, and must not hold the update.
 */

import type { Server } from "node:http";

export interface DrainOptions {
    /** How long to keep answering, with `Connection: close`, before closing the listeners. */
    lingerMs: number;
    /** When to stop waiting for in-flight requests, counted from the start of the drain. */
    deadlineMs: number;
}

/** Docker's stop timeout for this container is 20 s (`retire` in update.sh); both fit
 *  well inside it. */
export const DEFAULT_DRAIN: DrainOptions = { lingerMs: 3_000, deadlineMs: 15_000 };

/** Drain `servers` and resolve once each has closed, or at the deadline. */
export function drainServers(servers: Server[], options: DrainOptions = DEFAULT_DRAIN): Promise<void> {
    for (const server of servers) {
        // Prepended so the header is set before any handler writes the head; a head
        // written with its own headers merges with it rather than replacing it.
        server.prependListener("request", (_req, res) => {
            if (!res.headersSent) res.setHeader("connection", "close");
        });
    }

    const closed = new Promise<void>((resolve) => {
        setTimeout(() => {
            let open = servers.length;
            if (open === 0) return resolve();
            for (const server of servers) {
                server.close(() => {
                    open -= 1;
                    if (open === 0) resolve();
                });
                server.closeIdleConnections();
            }
        }, options.lingerMs).unref();
    });
    const deadline = new Promise<void>((resolve) => {
        setTimeout(() => {
            for (const server of servers) server.closeAllConnections();
            resolve();
        }, options.deadlineMs).unref();
    });
    return Promise.race([closed, deadline]);
}

/** Drain on the signals docker and a terminal send, then exit. Once: a second signal
 *  while draining changes nothing. */
export function exitGracefully(servers: Server[], options: DrainOptions = DEFAULT_DRAIN): void {
    let draining = false;
    const stop = (signal: NodeJS.Signals) => {
        if (draining) return;
        draining = true;
        console.log(`polaris-edge-guard: ${signal}, finishing in-flight requests`);
        void drainServers(servers, options).then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}
