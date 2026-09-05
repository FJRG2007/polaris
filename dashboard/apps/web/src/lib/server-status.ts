/**
 * Whether each registered server is answering, and how long it takes to say so.
 *
 * The probe opens a TCP connection to the port Polaris actually uses - sshd - and
 * times the handshake. ICMP is not an option from inside a container without raw
 * sockets, and it would answer a question nobody is asking: a machine that pings
 * but refuses SSH is down as far as everything in Polaris is concerned.
 *
 * Nothing here is cached or persisted. It is read from a page that polls, and a
 * stale reachability answer is worse than a fresh one that costs a connection.
 */

import { connect } from "node:net";
import { listHosts } from "./host-service";
import { LOCAL_SERVER_ID } from "./local-server";

/** Long enough for a busy machine on a slow link, short enough that a dead one
 *  does not hold the response open. */
const PROBE_TIMEOUT_MS = 3000;

export interface ServerStatus {
    /** "local", or the Host id. */
    readonly id: string;
    readonly state: "up" | "down";
    /** Handshake round trip in milliseconds. Null for the local box, which is the
     *  machine serving this request and has nothing to measure. */
    readonly latencyMs: number | null;
    /** Why it is not answering, in the words the connection used. */
    readonly detail: string | null;
}

/**
 * Time a TCP handshake against one endpoint. Never rejects: a refusal and a
 * timeout are both answers about the machine, not errors in this code.
 *
 * `timeoutMs` is for the one caller that asks about many addresses rather than
 * one: waiting three seconds on each of 254 of them is a wait nobody sits
 * through, and a machine on the same switch answers in single-digit
 * milliseconds or is not there.
 */
export async function probeTcp(
    address: string,
    port: number,
    timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<{ latencyMs: number; detail: string | null }> {
    const started = Date.now();
    return new Promise((resolve) => {
        const socket = connect({ host: address, port, timeout: timeoutMs });
        const settle = (detail: string | null): void => {
            socket.destroy();
            resolve({ latencyMs: Date.now() - started, detail });
        };
        socket.once("connect", () => settle(null));
        socket.once("timeout", () => settle(`No answer within ${Math.round(timeoutMs / 1000)} seconds`));
        socket.once("error", (error: NodeJS.ErrnoException) => settle(reason(error)));
    });
}

/** A connection failure in words an operator can act on. */
function reason(error: NodeJS.ErrnoException): string {
    if (error.code === "ECONNREFUSED") return "Nothing is listening on that port";
    if (error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH") return "No route to that address";
    if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return "That address does not resolve";
    return error.message;
}

/**
 * Probe every server this owner has. The local box is reported up without a
 * probe - it is the machine answering the request, so anything else would be a
 * contradiction - and the rest are dialled in parallel, since one unreachable
 * server should not add its timeout to the next one's wait.
 */
export async function serverStatuses(ownerId: string): Promise<ServerStatus[]> {
    const hosts = await listHosts(ownerId);
    const probed = await Promise.all(
        hosts.map(async (host) => {
            const { latencyMs, detail } = await probeTcp(host.address, host.port);
            return {
                id: host.id,
                state: detail === null ? ("up" as const) : ("down" as const),
                latencyMs: detail === null ? latencyMs : null,
                detail
            };
        })
    );
    return [{ id: LOCAL_SERVER_ID, state: "up", latencyMs: null, detail: null }, ...probed];
}
