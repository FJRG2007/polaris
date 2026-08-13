/**
 * Asking a Java server whether it is there, over TCP.
 *
 * The same question `raknet.ts` and `a2s.ts` ask their games, for the transport
 * where a plain connect looks like an answer and is not one. The container engine
 * publishes a host port the moment the container exists and accepts on the
 * server's behalf, so a socket opens cleanly while Minecraft is still fetching its
 * jar and generating a world - and reading that accept as "the server is up" is
 * what sent an operator into their router about a server that had not started yet.
 *
 * So the port is asked what only the game can answer. Server List Ping is what a
 * client sends to fill in a row on its server list: a handshake that asks for
 * status rather than to play, a request, and the server replies with the JSON it
 * would put on that row. Nothing else that happens to hold the port replies in
 * that shape, and a server that has not opened its world yet does not reply at all.
 *
 * Silence is not a claim about the router here. This runs against the address on
 * this network, with nothing in between to drop it, so silence means the game is
 * not answering - which is the whole reason it is worth asking.
 */

import { connect } from "node:net";

/** The one id the whole status exchange uses: the handshake, the request and the
 *  reply are all packet `0x00`. */
const STATUS_PACKET = 0x00;

/** `1`, the state a client asks for when it wants the server's row rather than to
 *  log in. */
const STATUS_STATE = 1;

/** The protocol version the client claims. `-1` is "not saying", which is what a
 *  ping that will never log in has to say: a server answers a status request from
 *  any version, and naming one would make this go stale with the game. */
const UNKNOWN_PROTOCOL = -1;

/** `{`. A status reply is JSON describing a server, so it is an object - checked
 *  because the question is whether Minecraft answered, not whether anything did. */
const JSON_OPENS = 0x7b;

/** How much of a reply to take before giving up on finding its shape. A status
 *  JSON carries the MOTD and a sample of who is on; anything past this is not one. */
const MAX_REPLY = 64 * 1024;

/** A number as the protocol writes it: seven bits at a time, low group first, with
 *  the top bit set on every group but the last. Read as unsigned so a negative
 *  version is the five bytes a client would send. */
function varInt(value: number): Buffer {
    const bytes: number[] = [];
    let rest = value >>> 0;
    do {
        const group = rest & 0x7f;
        rest >>>= 7;
        bytes.push(rest === 0 ? group : group | 0x80);
    } while (rest !== 0);
    return Buffer.from(bytes);
}

/** A string as the protocol writes it: its length, then its bytes. */
function string(value: string): Buffer {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([varInt(bytes.length), bytes]);
}

/** A packet as the protocol frames it: the length of what follows, its id, its body. */
function packet(id: number, body: Buffer): Buffer {
    const payload = Buffer.concat([varInt(id), body]);
    return Buffer.concat([varInt(payload.length), payload]);
}

/** The two packets that ask for a row on the server list, sent as one write - the
 *  server answers the pair, and splitting them only costs a round trip. */
function statusRequest(host: string, port: number): Buffer {
    const dialled = Buffer.alloc(2);
    dialled.writeUInt16BE(port);
    const handshake = packet(
        STATUS_PACKET,
        Buffer.concat([varInt(UNKNOWN_PROTOCOL), string(host), dialled, varInt(STATUS_STATE)])
    );
    return Buffer.concat([handshake, packet(STATUS_PACKET, Buffer.alloc(0))]);
}

/** A varint out of what has arrived, or null while the bytes for it have not. */
function readVarInt(buffer: Buffer, at: number): { value: number; size: number } | null {
    let value = 0;
    let shift = 0;
    for (let index = at; index < buffer.length; index += 1) {
        const byte = buffer[index] as number;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value, size: index - at + 1 };
        shift += 7;
        // A varint is five bytes at most. More than that is not one, and waiting
        // for a sixth is waiting for something that is never coming.
        if (shift > 28) return null;
    }
    return null;
}

/**
 * Whether what has arrived is a status reply, or null while it is too early to
 * tell.
 *
 * Three fields deep on purpose. A length and an id alone are two bytes, and two
 * bytes of anything can look like a packet; requiring the reply to go on and open
 * a JSON object is what keeps some other service on the number from reading as a
 * Minecraft server.
 */
function isStatusReply(buffer: Buffer): boolean | null {
    const length = readVarInt(buffer, 0);
    if (!length) return null;
    if (length.value < 2 || length.value > MAX_REPLY) return false;
    const id = readVarInt(buffer, length.size);
    if (!id) return null;
    if (id.value !== STATUS_PACKET) return false;
    const json = readVarInt(buffer, length.size + id.size);
    if (!json) return null;
    const at = length.size + id.size + json.size;
    if (buffer.length <= at) return null;
    return buffer.readUInt8(at) === JSON_OPENS;
}

/**
 * Ping a Java server's port and report whether the game answered.
 *
 * True is the game itself: the reply came back through whatever is between here
 * and the port, so against a public address it also proves the forward. False
 * means the game did not answer - which, against an address on this network, is a
 * server that has not finished starting, and against a public one is the usual
 * nothing: a closed forward, a router that will not loop its own address back
 * inward, or a server that is down.
 */
export function pingJava(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: timeoutMs });
        let received = Buffer.alloc(0);
        let settled = false;
        const settle = (answered: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(answered);
        };

        socket.once("connect", () => socket.write(statusRequest(host, port)));
        socket.on("data", (chunk) => {
            received = Buffer.concat([received, chunk]);
            const reply = isStatusReply(received);
            if (reply !== null) settle(reply);
            else if (received.length > MAX_REPLY) settle(false);
        });
        // A port the engine holds for a container that is not listening yet accepts
        // and then hangs up. Settling on the close is what makes that case cost
        // milliseconds instead of the whole timeout.
        socket.once("close", () => settle(false));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
    });
}
