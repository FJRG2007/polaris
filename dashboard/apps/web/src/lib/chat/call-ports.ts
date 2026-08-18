/**
 * The ports a call's media arrives on.
 *
 * Signalling goes through the edge on 443 with everything else, so nothing about
 * setting a call up needs a port. The audio does not: it is not HTTP, no proxy
 * can carry it, and it arrives on the ports the media server listens on.
 *
 * Pure, and deliberately: the card that draws this runs in the browser, and the
 * half that opens sockets to find out whether these are reachable is
 * `call-reach.ts`. Same split as the game ports, for the same reason.
 */

import type { RouterForwardRule } from "@/lib/router-guide";

/** One port a call needs. */
export interface CallPort {
    readonly port: number;
    readonly protocol: "tcp" | "udp";
    readonly label: string;
    /** Whether anything can be learned by knocking on it from outside. The media
     *  mux answers nothing it cannot attribute to a call already being set up,
     *  so silence there says nothing whatsoever. */
    readonly probeable: boolean;
}

/**
 * What the media server listens on.
 *
 * Two ports rather than the ten-thousand-port range the defaults use, which is
 * the whole reason this is a short list somebody can act on. UDP carries the
 * call; TCP is the way in for a network that will not pass UDP at all, and the
 * browser dials out to it, so it needs no help from the caller's own router.
 *
 * These are the numbers in `docker-compose.yml`. Written once here and read by
 * everything that talks about them.
 */
export const CALL_PORTS: readonly CallPort[] = [
    { port: 7882, protocol: "udp", label: "Call media", probeable: false },
    { port: 7881, protocol: "tcp", label: "Call media over TCP", probeable: true }
];

/** The rules to create in a router, in the shape the forwarding steps take. */
export const CALL_FORWARD_RULES: readonly RouterForwardRule[] = CALL_PORTS.map((entry) => ({
    name: `polaris-calls-${entry.protocol}`,
    protocol: entry.protocol.toUpperCase(),
    port: entry.port
}));

/** The one port that can be knocked on. Read off the list rather than written
 *  twice, so changing the list changes what is probed. */
export const CALL_TCP_PORT = CALL_PORTS.find((entry) => entry.protocol === "tcp")?.port ?? 7881;

export interface CallPortsReading {
    readonly ports: readonly CallPort[];
    /** Whether the media server is answering at all. Nothing is knocked on while
     *  it is not: a closed port behind a stopped server measures the server. */
    readonly running: boolean;
    /** Whether calls run through the server this stack starts. A server somebody
     *  else runs has its own address and its own router, and none of the advice
     *  here is about it. */
    readonly shipped: boolean;
    /** Whether a packet has been seen arriving from outside on the TCP port. */
    readonly confirmed: boolean;
    readonly confirmedAt: string | null;
    /** This machine's address on the network, for the forwarding rules. */
    readonly lanIp: string | null;
    /** Why nothing could be knocked on, when nothing could. Null when a probe
     *  ran - which still proves nothing on silence, only on an answer. */
    readonly cannotProbe: string | null;
}
