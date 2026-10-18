/**
 * Asking a DNS server one question over UDP, to see who answers port 53.
 *
 * The status screen needs three facts it cannot read from the engine's own
 * settings: whether anything answers on this machine's address, whether what
 * answers is the blocker, and whether blocking is on. One A query for the check
 * name tells all three - silence, an ordinary answer from somebody else, or the
 * blocker's `0.0.0.0`.
 *
 * The packet is written and read here rather than through `node:dns`, because
 * that module asks the resolvers this process was configured with and cannot be
 * pointed at one address for one question without changing them for everybody.
 *
 * Server-only.
 */

import { connect } from "node:net";
import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";

/** What came back, if anything did. */
export type DnsProbeAnswer =
    | { readonly kind: "silent" }
    | { readonly kind: "answered"; readonly rcode: number; readonly addresses: readonly string[] };

/** A query for one A record, with recursion desired. Exported for tests. */
export function encodeQuery(id: number, name: string): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const labels = name.split(".").filter(Boolean);
    const question = Buffer.concat([
        ...labels.map((label) =>
            Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])
        ),
        Buffer.from([0, 0, 1, 0, 1])
    ]);
    return Buffer.concat([header, question]);
}

/** Skip a possibly compressed name, returning the offset after it. */
function skipName(packet: Buffer, start: number): number {
    let offset = start;
    while (offset < packet.length) {
        const length = packet[offset] ?? 0;
        if (length === 0) return offset + 1;
        if ((length & 0xc0) === 0xc0) return offset + 2;
        offset += length + 1;
    }
    throw new Error("truncated name");
}

/** The response code and A addresses of a reply to query `id`, or null when
 *  the packet is not that reply. Exported for tests. */
export function decodeReply(
    packet: Buffer,
    id: number
): { rcode: number; addresses: string[] } | null {
    if (packet.length < 12 || packet.readUInt16BE(0) !== id) return null;
    const flags = packet.readUInt16BE(2);
    if ((flags & 0x8000) === 0) return null;
    const questions = packet.readUInt16BE(4);
    const answers = packet.readUInt16BE(6);
    try {
        let offset = 12;
        for (let index = 0; index < questions; index += 1) offset = skipName(packet, offset) + 4;
        const addresses: string[] = [];
        for (let index = 0; index < answers; index += 1) {
            offset = skipName(packet, offset);
            const type = packet.readUInt16BE(offset);
            const length = packet.readUInt16BE(offset + 8);
            const data = offset + 10;
            if (type === 1 && length === 4)
                addresses.push([...packet.subarray(data, data + 4)].join("."));
            offset = data + length;
        }
        return { rcode: flags & 0x0f, addresses };
    } catch {
        return { rcode: flags & 0x0f, addresses: [] };
    }
}

/** Ask `server` port 53 for `name`, waiting at most `timeoutMs`. */
export async function probeDns(
    server: string,
    name: string,
    timeoutMs = 1500
): Promise<DnsProbeAnswer> {
    const id = randomInt(1, 0xffff);
    const socket = createSocket("udp4");
    try {
        return await new Promise<DnsProbeAnswer>((resolve) => {
            const timer = setTimeout(() => resolve({ kind: "silent" }), timeoutMs);
            socket.on("error", () => {
                clearTimeout(timer);
                resolve({ kind: "silent" });
            });
            socket.on("message", (packet) => {
                const reply = decodeReply(packet, id);
                if (!reply) return;
                clearTimeout(timer);
                resolve({ kind: "answered", ...reply });
            });
            socket.send(encodeQuery(id, name), 53, server);
        });
    } finally {
        socket.close();
    }
}

/** Whether an answer for the check name says blocking is on. */
export function answerBlocks(answer: DnsProbeAnswer): boolean {
    return answer.kind === "answered" && answer.addresses.includes("0.0.0.0");
}

/**
 * Whether anything accepts a TCP connection on `server` port 53. The UDP question
 * misses a holder that listens but does not answer; a TCP listener, answering or
 * not, takes the connection, and the blocker publishes TCP 53 too.
 */
export async function tcpListening(server: string, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: server, port: 53 });
        const done = (listening: boolean): void => {
            clearTimeout(timer);
            socket.destroy();
            resolve(listening);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}
