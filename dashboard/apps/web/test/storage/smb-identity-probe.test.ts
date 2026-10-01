/**
 * Asking an SMB server who it is, over a real socket, against a server that
 * answers the way an SMB2 server does.
 *
 * The part that matters most is what is NOT sent: the exchange stops at the
 * server's NTLM CHALLENGE, so no AUTHENTICATE message - the only one that carries
 * anything derived from a password - ever leaves Polaris.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { probeSmbIdentity } from "@/lib/storage-whereabouts/smb-probe";

const GUID = Buffer.from("00112233445566778899aabbccddeeff", "hex");

function frame(message: Buffer): Buffer {
    const out = Buffer.alloc(4 + message.length);
    out.writeUInt32BE(message.length, 0);
    message.copy(out, 4);
    return out;
}

function header(command: number, status: number): Buffer {
    const out = Buffer.alloc(64);
    Buffer.from([0xfe, 0x53, 0x4d, 0x42]).copy(out, 0);
    out.writeUInt16LE(64, 4);
    out.writeUInt32LE(status, 8);
    out.writeUInt16LE(command, 12);
    out.writeUInt32LE(1, 16); // SERVER_TO_REDIR
    return out;
}

function negotiateResponse(): Buffer {
    const body = Buffer.alloc(65);
    body.writeUInt16LE(65, 0);
    body.writeUInt16LE(0x0302, 4);
    GUID.copy(body, 8);
    return frame(Buffer.concat([header(0, 0), body]));
}

function avPair(id: number, value: string): Buffer {
    const text = Buffer.from(value, "utf16le");
    const out = Buffer.alloc(4 + text.length);
    out.writeUInt16LE(id, 0);
    out.writeUInt16LE(text.length, 2);
    text.copy(out, 4);
    return out;
}

function challengeResponse(names: { netbios: string; dns: string }): Buffer {
    const info = Buffer.concat([
        avPair(2, "WORKGROUP"),
        avPair(1, names.netbios),
        avPair(3, names.dns),
        Buffer.alloc(4)
    ]);
    const challenge = Buffer.alloc(56);
    Buffer.from("NTLMSSP\0", "latin1").copy(challenge, 0);
    challenge.writeUInt32LE(2, 8);
    challenge.writeUInt16LE(info.length, 40);
    challenge.writeUInt16LE(info.length, 42);
    challenge.writeUInt32LE(56, 44);
    const token = Buffer.concat([challenge, info]);
    // Wrapped the way a server wraps it: a few bytes of SPNEGO in front.
    const blob = Buffer.concat([Buffer.from([0xa1, 0x81, 0x00, 0x30]), token]);
    const body = Buffer.alloc(8);
    body.writeUInt16LE(9, 0);
    body.writeUInt16LE(64 + 8, 4);
    body.writeUInt16LE(blob.length, 6);
    return frame(Buffer.concat([header(1, 0xc0000016), body, blob]));
}

let server: Server | null = null;
/** Every connection a test server accepted, so teardown can close them: a
 *  server does not finish closing while one is still open. */
const open = new Set<Socket>();

function track(socket: Socket): void {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
}

/** A server on a free local port that answers like an SMB2 server and records
 *  every message it is sent. */
async function smbServer(names = { netbios: "UNAS-PRO", dns: "unas-pro.local" }) {
    const received: Buffer[] = [];
    server = createServer((socket: Socket) => {
        track(socket);
        let pending = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 4) {
                const length = pending.readUInt32BE(0) & 0xffffff;
                if (pending.length < 4 + length) break;
                const message = pending.subarray(4, 4 + length);
                pending = pending.subarray(4 + length);
                received.push(message);
                const command = message.readUInt16LE(12);
                socket.write(command === 0 ? negotiateResponse() : challengeResponse(names));
            }
        });
        socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { port, received };
}

afterEach(async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
});

describe("asking an SMB server who it is", () => {
    it("reads its GUID and its names", async () => {
        const { port } = await smbServer();
        const result = await probeSmbIdentity("127.0.0.1", { port });
        expect(result).toEqual({
            ok: true,
            identity: {
                serverGuid: "00112233445566778899aabbccddeeff",
                netbiosName: "UNAS-PRO",
                dnsName: "unas-pro.local"
            }
        });
    });

    it("sends a NEGOTIATE and an NTLM NEGOTIATE, and never an AUTHENTICATE", async () => {
        const { port, received } = await smbServer();
        await probeSmbIdentity("127.0.0.1", { port });
        expect(received.map((message) => message.readUInt16LE(12))).toEqual([0, 1]);
        const setup = received[1]!;
        const ntlm = setup.indexOf(Buffer.from("NTLMSSP\0", "latin1"));
        expect(ntlm).toBeGreaterThan(0);
        // Message type 1: the client's opening, which carries no account and no
        // proof of any password.
        expect(setup.readUInt32LE(ntlm + 8)).toBe(1);
        for (const message of received) {
            let at = message.indexOf(Buffer.from("NTLMSSP\0", "latin1"));
            while (at >= 0) {
                expect(message.readUInt32LE(at + 8)).not.toBe(3);
                at = message.indexOf(Buffer.from("NTLMSSP\0", "latin1"), at + 1);
            }
        }
    });

    it("answers closed for a port nothing listens on", async () => {
        const { port } = await smbServer();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
        const result = await probeSmbIdentity("127.0.0.1", { port });
        expect(result).toMatchObject({ ok: false, reason: "closed" });
    });

    it("answers refused for something that is not an SMB server", async () => {
        server = createServer((socket) => {
            track(socket);
            socket.end("SSH-2.0-OpenSSH_9.6\r\n");
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const result = await probeSmbIdentity("127.0.0.1", { port, timeoutMs: 1_000 });
        expect(result).toMatchObject({ ok: false, reason: "refused" });
    });
});
