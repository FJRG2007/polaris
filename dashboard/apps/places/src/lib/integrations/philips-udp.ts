/**
 * The datagrams a Philips air purifier is spoken to over: CoAP on UDP 5683.
 *
 * Its own file so everything above it can be tested without a network: the
 * tests replace this module with a unit made of fixtures.
 *
 * Two shapes of use, as with Gree (`gree-udp.ts`), and for the same reason. A
 * link to one unit - a socket connected to its address, so that a unit whose
 * firmware has switched local control off, and so answers with ICMP "port
 * unreachable", is told apart from one that is simply not there. And a scan: one
 * datagram to every address on a subnet, every answer collected, since a
 * broadcast from the web container's Docker bridge never reaches the LAN while a
 * datagram to one address does, its answer coming back through the same NAT
 * entry.
 *
 * A confirmable message from the unit is acknowledged on arrival, as aiocoap
 * does; some firmware sends its notifications confirmable and stops sending to a
 * client that never answers.
 *
 * Server-only.
 */

import { createSocket, type Socket } from "node:dgram";
import { COAP_PORT, CoapCode, CoapType, decodeCoap, encodeCoap, type CoapMessage } from "./coap";

/** Nothing a unit says is anywhere near this; anything bigger is not a unit. */
const MAX_DATAGRAM = 16 * 1024;

export interface CoapLink {
    send(message: CoapMessage): void;
    /** The next message this matches, taken off the queue, or null once `ms`
     *  has passed with none. */
    next(match: (message: CoapMessage) => boolean, ms: number): Promise<CoapMessage | null>;
    /** Whether the unit's address answered "port unreachable": something is
     *  there, and it is not listening for CoAP. */
    readonly refused: boolean;
    /** Called for every message nobody was waiting for - a notification. */
    onUnclaimed(listener: ((message: CoapMessage) => void) | null): void;
    close(): void;
}

interface Waiter {
    readonly match: (message: CoapMessage) => boolean;
    readonly resolve: (message: CoapMessage | null) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

/** A link to one unit. Resolves once the socket is ready to send. */
export function openCoapLink(address: string, port = COAP_PORT): Promise<CoapLink> {
    return new Promise((resolve, reject) => {
        const socket: Socket = createSocket({ type: "udp4" });
        const queue: CoapMessage[] = [];
        const waiters: Waiter[] = [];
        let refused = false;
        let closed = false;
        let unclaimed: ((message: CoapMessage) => void) | null = null;

        const settleAll = () => {
            for (const waiter of waiters.splice(0)) {
                clearTimeout(waiter.timer);
                waiter.resolve(null);
            }
        };
        const link: CoapLink = {
            send(message) {
                if (closed) return;
                socket.send(encodeCoap(message), (error) => {
                    if (error && (error as NodeJS.ErrnoException).code === "ECONNREFUSED")
                        refused = true;
                });
            },
            next(match, ms) {
                const index = queue.findIndex(match);
                if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
                if (closed) return Promise.resolve(null);
                return new Promise((done) => {
                    const waiter: Waiter = {
                        match,
                        resolve: done,
                        timer: setTimeout(() => {
                            const at = waiters.indexOf(waiter);
                            if (at >= 0) waiters.splice(at, 1);
                            done(null);
                        }, ms)
                    };
                    waiters.push(waiter);
                });
            },
            get refused() {
                return refused;
            },
            onUnclaimed(listener) {
                unclaimed = listener;
                if (listener) for (const message of queue.splice(0)) listener(message);
            },
            close() {
                if (closed) return;
                closed = true;
                settleAll();
                try {
                    socket.close();
                } catch {
                    // Already closed.
                }
            }
        };

        socket.on("error", (error: NodeJS.ErrnoException) => {
            // A connected UDP socket hears ICMP "port unreachable" as this.
            if (error.code === "ECONNREFUSED") {
                refused = true;
                settleAll();
                return;
            }
            if (!closed) link.close();
        });
        socket.on("message", (data) => {
            if (data.length > MAX_DATAGRAM) return;
            const message = decodeCoap(data);
            if (!message) return;
            if (message.type === CoapType.CON) {
                link.send({
                    type: CoapType.ACK,
                    code: CoapCode.EMPTY,
                    messageId: message.messageId,
                    token: Buffer.alloc(0)
                });
            }
            const waiter = waiters.find((entry) => entry.match(message));
            if (waiter) {
                waiters.splice(waiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
                return;
            }
            if (unclaimed) unclaimed(message);
            else if (queue.length < 32) queue.push(message);
        });
        let connected = false;
        socket.once("error", (error) => {
            if (!connected) reject(error);
        });
        socket.connect(port, address, () => {
            connected = true;
            resolve(link);
        });
    });
}

export interface CoapReply {
    readonly address: string;
    readonly message: CoapMessage;
}

/**
 * Send one message to every target and collect what comes back for the window.
 * An answer is only taken from an address that was written to; a send that
 * fails for one address is that address not answering.
 */
export function coapScan(
    targets: readonly string[],
    message: CoapMessage,
    windowMs: number,
    port = COAP_PORT
): Promise<CoapReply[]> {
    const asked = new Set(targets);
    const payload = encodeCoap(message);
    return new Promise((resolve) => {
        const replies: CoapReply[] = [];
        const socket = createSocket({ type: "udp4" });
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
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
            if (data.length > MAX_DATAGRAM || !asked.has(from.address)) return;
            const decoded = decodeCoap(data);
            if (decoded) replies.push({ address: from.address, message: decoded });
        });
        socket.bind(0, () => {
            timer = setTimeout(finish, windowMs);
            for (const target of targets) {
                socket.send(payload, port, target, () => {
                    // Per address, and silent on purpose: see above.
                });
            }
        });
    });
}
