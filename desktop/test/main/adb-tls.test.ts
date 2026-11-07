/**
 * A_STLS on the network link: a loopback "TV" that answers CNXN with STLS,
 * turns the socket into a TLS server that asks for this computer's certificate,
 * and only then sends its CNXN - as adbd does on its Wireless debugging port.
 */

import { TLSSocket } from "node:tls";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { adbCertificate } from "../../src/main/adb-pairing";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { AdbConnection, encodePacket, newAdbKey } from "../../src/main/adb-client";

const A_CNXN = 0x4e584e43;
const A_STLS = 0x534c5453;
const VERSION = 0x01000000;

const KEY = newAdbKey();
const TV_KEY = newAdbKey();
const TV_CERTIFICATE = adbCertificate(TV_KEY);

let server: Server | null = null;

afterEach(() => {
    server?.close();
    server = null;
});

/** A TV that asks for TLS; reports whether this computer showed a certificate. */
function tlsTv(): Promise<{ port: number; peers: boolean[]; }> {
    const peers: boolean[] = [];
    server = createServer((socket: Socket) => {
        // Read packet by packet: the ClientHello can arrive in the same chunk as STLS, and is TLS's to read.
        let pending = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 24 && pending.length >= 24 + pending.readUInt32LE(12)) {
                const command = pending.readUInt32LE(0);
                pending = pending.subarray(24 + pending.readUInt32LE(12));
                if (command === A_CNXN) socket.write(encodePacket(A_STLS, VERSION, 0));
                if (command !== A_STLS) continue;
                socket.off("data", onData);
                // adbd reads exactly one packet and leaves the rest to TLS; a stream in between does the same here.
                const plain = new Duplex({ read: () => undefined, write: (data, _encoding, done) => socket.write(data, done) });
                if (pending.length) plain.push(pending);
                socket.on("data", (data: Buffer) => plain.push(data));
                const secure = new TLSSocket(plain, {
                    isServer: true,
                    cert: TV_CERTIFICATE,
                    key: TV_KEY,
                    requestCert: true,
                    rejectUnauthorized: false
                });
                secure.on("error", () => socket.destroy());
                secure.once("secure", () => {
                    const peer = secure.getPeerCertificate();
                    peers.push(Boolean(peer && Object.keys(peer).length));
                    secure.write(encodePacket(A_CNXN, VERSION, 4096, Buffer.from("device::ro.product.model=Fixture;\0")));
                });
            }
        };
        socket.on("data", onData);
        socket.on("error", () => undefined);
    });
    return new Promise((resolve) => {
        server?.listen(0, "127.0.0.1", () => resolve({ port: (server?.address() as AddressInfo).port, peers }));
    });
}

describe("A_STLS", () => {
    it("carries on over TLS with this computer's certificate and opens on the TV's CNXN", async () => {
        const { port, peers } = await tlsTv();
        const adb = new AdbConnection({
            host: "127.0.0.1",
            port,
            key: KEY,
            certificate: adbCertificate(KEY),
            connectMs: 5_000,
            approveMs: 5_000,
            commandMs: 5_000
        });
        try {
            await adb.open();
            expect(peers).toEqual([true]);
        } finally {
            adb.close();
        }
    });

    it("says the TV asks for TLS when there is no certificate to offer", async () => {
        const { port } = await tlsTv();
        const adb = new AdbConnection({ host: "127.0.0.1", port, key: KEY, connectMs: 5_000, approveMs: 5_000, commandMs: 5_000 });
        try {
            await expect(adb.open()).rejects.toThrow("asks for TLS");
        } finally {
            adb.close();
        }
    });
});
