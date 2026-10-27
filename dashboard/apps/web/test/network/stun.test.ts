/** The STUN binding request and the reading of its answer (RFC 5389). */

import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { bindingRequest, mappedAddress, stunMappedIp } from "@/lib/network/stun";

const TXN = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const COOKIE = 0x2112a442;

/** A binding success carrying the given attributes. */
function response(attributes: Buffer[], txn: Uint8Array = TXN, type = 0x0101): Buffer {
    const body = Buffer.concat(attributes);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(COOKIE, 4);
    Buffer.from(txn).copy(header, 8);
    return Buffer.concat([header, body]);
}

function addressAttribute(type: number, ip: string, xor: boolean, family = 0x01): Buffer {
    const attribute = Buffer.alloc(12);
    attribute.writeUInt16BE(type, 0);
    attribute.writeUInt16BE(8, 2);
    attribute.writeUInt8(family, 5);
    attribute.writeUInt16BE(xor ? 50000 ^ 0x2112 : 50000, 6);
    const raw = ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
    attribute.writeUInt32BE(xor ? (raw ^ COOKIE) >>> 0 : raw, 8);
    return attribute;
}

describe("the binding request", () => {
    it("is a 20-byte header with the magic cookie and the transaction id", () => {
        const message = bindingRequest(TXN);
        expect(message.length).toBe(20);
        expect(message.readUInt16BE(0)).toBe(0x0001);
        expect(message.readUInt16BE(2)).toBe(0);
        expect(message.readUInt32BE(4)).toBe(COOKIE);
        expect([...message.subarray(8)]).toEqual([...TXN]);
    });

    it("refuses a transaction id of the wrong size", () => {
        expect(() => bindingRequest(new Uint8Array(4))).toThrow();
    });
});

describe("the answer", () => {
    it("reads XOR-MAPPED-ADDRESS", () => {
        const message = response([addressAttribute(0x0020, "98.97.0.20", true)]);
        expect(mappedAddress(message, TXN)).toBe("98.97.0.20");
    });

    it("prefers XOR-MAPPED-ADDRESS over the legacy attribute", () => {
        const message = response([
            addressAttribute(0x0001, "51.0.0.1", false),
            addressAttribute(0x0020, "98.97.0.20", true)
        ]);
        expect(mappedAddress(message, TXN)).toBe("98.97.0.20");
    });

    it("falls back to MAPPED-ADDRESS", () => {
        const message = response([addressAttribute(0x0001, "51.0.0.1", false)]);
        expect(mappedAddress(message, TXN)).toBe("51.0.0.1");
    });

    it("ignores another transaction, another type, IPv6 and a truncated message", () => {
        const good = addressAttribute(0x0020, "98.97.0.20", true);
        expect(mappedAddress(response([good], new Uint8Array(12)), TXN)).toBeNull();
        expect(mappedAddress(response([good], TXN, 0x0111), TXN)).toBeNull();
        const v6 = addressAttribute(0x0020, "1.2.3.4", true, 0x02);
        expect(mappedAddress(response([v6]), TXN)).toBeNull();
        expect(mappedAddress(response([good]).subarray(0, 26), TXN)).toBeNull();
        expect(mappedAddress(Buffer.alloc(4), TXN)).toBeNull();
    });
});

describe("asking a server", () => {
    it("round-trips with a local STUN responder, and is null on silence", async () => {
        const server = createSocket("udp4");
        server.on("message", (message, from) => {
            const txn = message.subarray(8, 20);
            server.send(
                response([addressAttribute(0x0020, "98.97.0.20", true)], txn),
                from.port,
                from.address
            );
        });
        await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
        const port = server.address().port;
        try {
            expect(await stunMappedIp([{ host: "127.0.0.1", port }], 1000)).toBe("98.97.0.20");
        } finally {
            server.close();
        }
        expect(await stunMappedIp([{ host: "127.0.0.1", port }], 200)).toBeNull();
    });
});
