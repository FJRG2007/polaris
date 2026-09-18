/**
 * Asking an ARK server whether it is there, over UDP.
 *
 * The same problem RakNet solves for Bedrock, for the other game. ARK's game port
 * says nothing to anybody who is not already playing, so a probe against it proves
 * nothing and never will - but the query port beside it speaks Valve's A2S, which
 * is the protocol Steam's own server browser uses to fill in a server's name and
 * player count. A server that answers that answered a packet that came in from
 * outside, which is the whole question.
 *
 * This is why an ARK server could sit there perfectly reachable - listed in Steam,
 * people playing on it - while Polaris kept saying its ports were unconfirmed: the
 * only UDP question being asked was RakNet's, which ARK does not speak.
 *
 * Silence still means nothing here. It only ever turns silence into a yes.
 */

import { createSocket } from "node:dgram";

/** Every A2S packet begins with this, request and reply alike. */
const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** `A2S_INFO`: the query Steam sends to fill a row in the server browser. */
const INFO_REQUEST = Buffer.concat([HEADER, Buffer.from("TSource Engine Query\0", "latin1")]);

/** `I`, a server describing itself, and `A`, a server handing back a challenge to
 *  be asked again with. Either is an answer; which one it is only matters to a
 *  client that wants the details. */
const INFO_REPLY = 0x49;
const CHALLENGE_REPLY = 0x41;

/** Whether a datagram is an A2S reply rather than whatever else was on the port. */
function isReply(message: Buffer): boolean {
    if (message.length < 5 || !message.subarray(0, 4).equals(HEADER)) return false;
    const kind = message.readUInt8(4);
    return kind === INFO_REPLY || kind === CHALLENGE_REPLY;
}

/**
 * Ask a Steam query port to describe itself and report whether it answered.
 *
 * True is proof: the reply made the whole round trip, through the router if the
 * host given was the public address. False is not a claim - the port may be
 * blocked, the router may refuse to loop its own public address back inward, or
 * the server may still be loading its map.
 */
export function pingSteamQuery(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createSocket("udp4");
        let settled = false;
        const settle = (answered: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.removeAllListeners();
            try {
                socket.close();
            } catch {
                // Already closing, which is the same outcome.
            }
            resolve(answered);
        };
        const timer = setTimeout(() => settle(false), timeoutMs);
        // Unref so a probe left in flight cannot hold the process open.
        timer.unref?.();

        socket.once("error", () => settle(false));
        socket.on("message", (message) => {
            if (isReply(message)) settle(true);
        });
        socket.send(INFO_REQUEST, port, host, (error) => {
            if (error) settle(false);
        });
    });
}
