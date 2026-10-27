/**
 * A STUN binding request (RFC 5389) over plain UDP: what address a public server
 * saw this box's packet come from. No dependency - the message is twenty bytes
 * out and a handful of attributes back.
 *
 * Evidence for the carrier-NAT check: a mapped address that differs from the one
 * the HTTP echo services report means more than one NAT sits in the way.
 */

import { createSocket } from "node:dgram";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;
const FAMILY_IPV4 = 0x01;

/** The servers the call server already asks (stun_servers in the compose file). */
export const STUN_SERVERS: readonly { host: string; port: number }[] = [
    { host: "stun.l.google.com", port: 19302 },
    { host: "stun1.l.google.com", port: 19302 }
];

const TIMEOUT_MS = 1_500;

/** A binding request with no attributes for the given 12-byte transaction id. */
export function bindingRequest(transactionId: Uint8Array): Buffer {
    if (transactionId.length !== 12) throw new Error("A STUN transaction id is 12 bytes");
    const message = Buffer.alloc(20);
    message.writeUInt16BE(BINDING_REQUEST, 0);
    message.writeUInt16BE(0, 2);
    message.writeUInt32BE(MAGIC_COOKIE, 4);
    Buffer.from(transactionId).copy(message, 8);
    return message;
}

/**
 * The IPv4 a binding success response names, or null for anything else: another
 * message type, another transaction, a truncated attribute, an IPv6 mapping.
 * XOR-MAPPED-ADDRESS wins over the legacy MAPPED-ADDRESS when both are present.
 */
export function mappedAddress(message: Uint8Array, transactionId: Uint8Array): string | null {
    const buffer = Buffer.from(message);
    if (buffer.length < 20) return null;
    if (buffer.readUInt16BE(0) !== BINDING_SUCCESS) return null;
    if (buffer.readUInt32BE(4) !== MAGIC_COOKIE) return null;
    if (!buffer.subarray(8, 20).equals(Buffer.from(transactionId))) return null;
    const end = Math.min(buffer.length, 20 + buffer.readUInt16BE(2));
    let plain: string | null = null;
    for (let offset = 20; offset + 4 <= end;) {
        const type = buffer.readUInt16BE(offset);
        const length = buffer.readUInt16BE(offset + 2);
        const value = offset + 4;
        if (value + length > end) return plain;
        const isAddress = type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS;
        if (isAddress && length >= 8 && buffer.readUInt8(value + 1) === FAMILY_IPV4) {
            let raw = buffer.readUInt32BE(value + 4);
            if (type === XOR_MAPPED_ADDRESS) raw = (raw ^ MAGIC_COOKIE) >>> 0;
            const address = [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join(
                "."
            );
            if (type === XOR_MAPPED_ADDRESS) return address;
            plain = address;
        }
        // Attributes are padded to a multiple of four bytes.
        offset = value + Math.ceil(length / 4) * 4;
    }
    return plain;
}

/** Ask one server: null on silence, an unusable answer or an error. */
function ask(server: { host: string; port: number }, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
        const transactionId = crypto.getRandomValues(new Uint8Array(12));
        const socket = createSocket("udp4");
        let settled = false;
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on("error", () => finish(null));
        socket.on("message", (message) => {
            const address = mappedAddress(message, transactionId);
            if (address) finish(address);
        });
        socket.send(bindingRequest(transactionId), server.port, server.host, (error) => {
            if (error) finish(null);
        });
    });
}

/** The address a STUN server mapped this box to, trying each server in turn. */
export async function stunMappedIp(
    servers: readonly { host: string; port: number }[] = STUN_SERVERS,
    timeoutMs = TIMEOUT_MS
): Promise<string | null> {
    for (const server of servers) {
        const address = await ask(server, timeoutMs);
        if (address) return address;
    }
    return null;
}
