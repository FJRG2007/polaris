/**
 * Asking a Bedrock server whether it is there, over UDP.
 *
 * UDP is normally unprovable from here - an unanswered packet and a blocked one
 * are the same silence - which is why the port probe skipped it and a Bedrock
 * server could only ever be proven by a player arriving. Except a Bedrock server
 * does answer: RakNet, the transport underneath it, replies to an unconnected
 * ping with an unconnected pong, and that pong is a packet that came back. It
 * carries a 16-byte magic constant, so it cannot be confused with whatever else
 * happened to be listening on the port.
 *
 * The silence still means nothing, exactly as before. This only ever turns
 * silence into a yes.
 */

import { createSocket } from "node:dgram";

/** The constant RakNet puts in every offline packet, and the only reason an
 *  answer can be trusted: anything else on that port replies without it. */
const MAGIC = Buffer.from([
    0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78
]);

/** `0x01`, an unconnected ping: the packet a client sends before it has a session. */
const PING = 0x01;

/** `0x1c`, an unconnected pong: what a Bedrock server sends back. */
const PONG = 0x1c;

/** Header of a pong up to and including the magic: the id, the echoed time, the
 *  server's GUID, then the constant. The MOTD follows and is not read - what is
 *  being asked is whether anything answered, not what it calls itself. */
const PONG_MAGIC_AT = 1 + 8 + 8;

/** An unconnected ping, built fresh so the GUID and time differ between attempts
 *  and a router or server that dedupes identical datagrams cannot swallow the
 *  second one. */
function pingPacket(): Buffer {
    const packet = Buffer.alloc(1 + 8 + MAGIC.length + 8);
    packet.writeUInt8(PING, 0);
    packet.writeBigInt64BE(BigInt(Date.now()), 1);
    MAGIC.copy(packet, 9);
    // The client GUID is ours to pick and is never checked; random keeps two
    // probes from looking like one retransmission.
    packet.writeUInt32BE((Math.random() * 0xffffffff) >>> 0, 25);
    packet.writeUInt32BE((Math.random() * 0xffffffff) >>> 0, 29);
    return packet;
}

/** Whether a datagram is genuinely a RakNet pong rather than anything else that
 *  answered on that port. */
function isPong(message: Buffer): boolean {
    if (message.length < PONG_MAGIC_AT + MAGIC.length) return false;
    if (message.readUInt8(0) !== PONG) return false;
    return message.subarray(PONG_MAGIC_AT, PONG_MAGIC_AT + MAGIC.length).equals(MAGIC);
}

/**
 * Ping a Bedrock server and report whether it answered.
 *
 * True is proof: a valid pong is a packet that made the whole round trip. False
 * is not a claim - the port may be blocked, the router may refuse to loop its own
 * public address back inward, or the server may still be starting.
 */
export function pingBedrock(host: string, port: number, timeoutMs: number): Promise<boolean> {
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
            if (isPong(message)) settle(true);
        });
        socket.send(pingPacket(), port, host, (error) => {
            if (error) settle(false);
        });
    });
}
