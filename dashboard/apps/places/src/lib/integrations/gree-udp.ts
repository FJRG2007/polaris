/**
 * The one thing a Gree unit is spoken to over: UDP datagrams to port 7000.
 *
 * Its own file so the protocol above it can be tested without a network: the
 * tests replace this module, and everything Gree says is then a fixture.
 *
 * Two shapes of use. A request to one unit, waited on until the unit answers or
 * the window closes. And a scan, sent to many at once - every address on a
 * subnet, or the broadcast address - with every answer collected until the
 * window closes.
 *
 * Why both exist for a scan is the deployment. Polaris' web container sits on a
 * Docker bridge, and a broadcast from there stays on the bridge: it never
 * reaches the LAN, and nothing on the LAN could answer it through the NAT if it
 * did. A datagram to one address does get out, and the unit's reply comes back
 * through the same NAT entry - so a scan of the subnet, one address at a time,
 * finds units from inside the container where the broadcast cannot. Where
 * Polaris runs on the host's own network the broadcast works as well, and costs
 * nothing to try.
 *
 * Server-only.
 */

import { createSocket } from "node:dgram";

export const GREE_PORT = 7000;

/** The address a broadcast goes to. Only ever used for a scan. */
export const GREE_BROADCAST = "255.255.255.255";

/** Nothing a unit says is anywhere near this; anything bigger is not a unit. */
const MAX_DATAGRAM = 16 * 1024;

export interface GreeDatagram {
    readonly address: string;
    readonly data: Buffer;
}

export interface GreeExchange {
    /** Where to send the payload, each on port 7000. */
    readonly targets: readonly string[];
    readonly payload: Buffer;
    /** How long to listen once everything is sent. */
    readonly windowMs: number;
    /** Stop listening as soon as one answer satisfies this. */
    readonly until?: (reply: GreeDatagram) => boolean;
}

/**
 * Send, and collect what comes back for the window.
 *
 * An answer is only taken from an address that was written to, unless the
 * broadcast was one of the targets - then anybody on the segment may answer,
 * which is the point of a broadcast. A send that fails for one address (no
 * route, nobody there) is that address not answering, not the whole exchange
 * failing.
 */
export function greeExchange(exchange: GreeExchange): Promise<GreeDatagram[]> {
    const { targets, payload, windowMs, until } = exchange;
    const broadcast = targets.includes(GREE_BROADCAST);
    const asked = new Set(targets);
    return new Promise((resolve) => {
        const replies: GreeDatagram[] = [];
        const socket = createSocket({ type: "udp4" });
        let timer: ReturnType<typeof setTimeout> | null = null;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // Already closed; what was collected is the answer.
            }
            resolve(replies);
        };
        socket.on("error", finish);
        socket.on("message", (data, from) => {
            if (data.length > MAX_DATAGRAM) return;
            if (!broadcast && !asked.has(from.address)) return;
            const reply = { address: from.address, data };
            replies.push(reply);
            if (until?.(reply)) finish();
        });
        socket.bind(0, () => {
            if (broadcast) {
                try {
                    socket.setBroadcast(true);
                } catch {
                    // Refused by the host: the unicast targets still go out.
                }
            }
            timer = setTimeout(finish, windowMs);
            for (const target of targets) {
                socket.send(payload, GREE_PORT, target, () => {
                    // Per address, and silent on purpose: see above.
                });
            }
        });
    });
}
