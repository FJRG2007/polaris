/**
 * Wireless debugging pairing: SPAKE2 known answers, the packet framing, and the
 * exchange against a scripted TV - right code, wrong code, a TV that hangs up,
 * and garbage - with no network.
 *
 * The SPAKE2 vectors were computed by test/fixtures/spake2-vectors.py, an
 * independent transcription of BoringSSL's spake25519.cc over djb's reference
 * ed25519.py (full-integer scalars, no subgroup shortcuts), not by this code.
 * BoringSSL and AOSP publish no fixed SPAKE2 vectors (their tests use random
 * exchanges), so these are cross-implementation answers, not BoringSSL output.
 */

import { describe, expect, it } from "vitest";
import { AdbConnection, androidPublicKey, encodePacket, newAdbKey, PacketReader, type AdbLinkOpener } from "@/main/adb-client";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { CLIENT_NAME, SERVER_NAME, Spake2, passwordScalar } from "@/main/adb-spake2";
import * as pairing from "@/main/adb-pairing";

const KEYING = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
const PASSWORD = Buffer.concat([Buffer.from("123456"), KEYING]);
const ALICE_RANDOM = createHash("sha512").update("alice").digest();
const BOB_RANDOM = createHash("sha512").update("bob").digest();

const VECTORS = {
    alice: "ba2893bc172e95f246fdb91eb8d30efdb5ba61e906557220cc8e98ea198b03c5",
    bob: "afbd8e5c381d1d71058a72928150e17f2fb4a1cefbe57e8d1a7cb85fdc4fd355",
    key: "4c170897ef29d6ea6eba4d7eecbaeb352ced49b8c7ab3a2e16e8b28ffe55829244fe81fc94e8ef9c8699edeb679c66cd5dd2ef2a148fe5ab479467e3c9c93390",
    bobWrong: "7e5f8d8e33cfbe34d5afd8bf2852aef02dccc4d9ec030331af603b3483c491d8",
    aliceVsWrong:
        "f41641c25178dcaabf6f864dde46e960adf155e607eb0169a9d7364b70cf0caece233d8a6b518746003c07845a6353c9914f3ab4d7d8a60ffa9d61183f9b83f0"
};

describe("SPAKE2 as BoringSSL speaks it", () => {
    it("matches the reference messages and key for both roles", () => {
        const alice = new Spake2("alice", CLIENT_NAME, SERVER_NAME, PASSWORD, ALICE_RANDOM);
        const bob = new Spake2("bob", SERVER_NAME, CLIENT_NAME, PASSWORD, BOB_RANDOM);
        expect(alice.message.toString("hex")).toBe(VECTORS.alice);
        expect(bob.message.toString("hex")).toBe(VECTORS.bob);
        expect(alice.finish(bob.message).toString("hex")).toBe(VECTORS.key);
        expect(bob.finish(alice.message).toString("hex")).toBe(VECTORS.key);
    });

    it("gives a different key when the other side used another code", () => {
        const wrong = Buffer.concat([Buffer.from("654321"), KEYING]);
        const bob = new Spake2("bob", SERVER_NAME, CLIENT_NAME, wrong, BOB_RANDOM);
        expect(bob.message.toString("hex")).toBe(VECTORS.bobWrong);
        const alice = new Spake2("alice", CLIENT_NAME, SERVER_NAME, PASSWORD, ALICE_RANDOM);
        expect(alice.finish(bob.message).toString("hex")).toBe(VECTORS.aliceVsWrong);
    });

    it("keeps the password scalar a multiple of eight below eight times the order", () => {
        for (const code of ["000000", "123456", "999999"]) {
            const { scalar } = passwordScalar(Buffer.from(code));
            expect(scalar % 8n).toBe(0n);
            expect(scalar < 8n * 2n ** 253n).toBe(true);
        }
    });

    it("refuses a message off the curve, a short one, and a second finish", () => {
        const alice = () => new Spake2("alice", CLIENT_NAME, SERVER_NAME, PASSWORD, ALICE_RANDOM);
        expect(() => alice().finish(Buffer.alloc(31))).toThrow(/32 bytes/);
        // y = 2 has no x on edwards25519.
        const offCurve = Buffer.alloc(32);
        offCurve[0] = 2;
        expect(() => alice().finish(offCurve)).toThrow(/not a point/);
        const once = alice();
        once.finish(Buffer.from(VECTORS.bob, "hex"));
        expect(() => once.finish(Buffer.from(VECTORS.bob, "hex"))).toThrow(/already finished/);
    });
});

describe("pairing packets", () => {
    it("frames a packet with version 1, its type and a big-endian length", () => {
        const packet = pairing.encodePairingPacket(pairing.PACKET_PEER_INFO, Buffer.alloc(300, 7));
        expect([...packet.subarray(0, 6)]).toEqual([1, 1, 0, 0, 1, 44]);
        expect(pairing.readPairingHeader(packet.subarray(0, 6))).toEqual({ type: pairing.PACKET_PEER_INFO, length: 300 });
    });

    it("refuses what adbd refuses: another version, an unknown type, an empty or oversized payload", () => {
        const header = (version: number, type: number, length: number) => {
            const out = Buffer.alloc(6);
            out.writeUInt8(version, 0);
            out.writeUInt8(type, 1);
            out.writeUInt32BE(length, 2);
            return out;
        };
        expect(() => pairing.readPairingHeader(header(2, 0, 32))).toThrow(pairing.PairingError);
        expect(() => pairing.readPairingHeader(header(1, 9, 32))).toThrow(pairing.PairingError);
        expect(() => pairing.readPairingHeader(header(1, 0, 0))).toThrow(pairing.PairingError);
        expect(() => pairing.readPairingHeader(header(1, 1, 16385))).toThrow(pairing.PairingError);
        expect(pairing.readPairingHeader(header(1, 1, 16384)).length).toBe(16384);
    });

    it("puts the ADB key in an 8192-byte PeerInfo of type 0", () => {
        const info = pairing.peerInfo(Buffer.from("key user@host\0"));
        expect(info.length).toBe(pairing.PEER_INFO_BYTES);
        expect(info[0]).toBe(0);
        expect(info.subarray(1, 15).toString()).toBe("key user@host\0");
        expect(info.subarray(15).every((byte) => byte === 0)).toBe(true);
    });

    it("seals with a per-direction counter nonce, and a wrong key does not open", () => {
        const key = Buffer.from(VECTORS.key, "hex");
        const ours = new pairing.PairingCipher(key);
        const theirs = new pairing.PairingCipher(key);
        const first = ours.encrypt(Buffer.from("one"));
        const second = ours.encrypt(Buffer.from("one"));
        expect(first.length).toBe(3 + 16);
        expect(first.equals(second)).toBe(false);
        expect(theirs.decrypt(first)?.toString()).toBe("one");
        expect(theirs.decrypt(second)?.toString()).toBe("one");
        expect(new pairing.PairingCipher(Buffer.alloc(64, 1)).decrypt(ours.encrypt(Buffer.from("x")))).toBeNull();
    });

    it("reads a six-digit code and nothing else", () => {
        expect(pairing.readPairingCode(" 123 456 ")).toBe("123456");
        expect(pairing.readPairingCode("12345")).toBeNull();
        expect(pairing.readPairingCode("12345a")).toBeNull();
        expect(pairing.readPairingCode(123456)).toBeNull();
    });
});

/** A TV's pairing side, scripted: the server half of AOSP's exchange over an in-memory channel. */
function scriptedTv(tvCode: string, behaviour: "answer" | "hang-up" | "garbage" = "answer") {
    const reader = new pairing.StreamReader();
    const toClient = new pairing.StreamReader();
    const received: Buffer[] = [];
    const channel: pairing.PairingChannel = {
        write: (data) => reader.push(data),
        read: (length) => toClient.read(length),
        exportKeyingMaterial: (length, label) => {
            expect(label).toBe("adb-label\0");
            return KEYING.subarray(0, length);
        }
    };
    const run = (async () => {
        const header = pairing.readPairingHeader(await reader.read(6));
        expect(header.type).toBe(pairing.PACKET_SPAKE2);
        const clientMessage = await reader.read(header.length);
        const bob = new Spake2("bob", SERVER_NAME, CLIENT_NAME, Buffer.concat([Buffer.from(tvCode), KEYING]), BOB_RANDOM);
        toClient.push(pairing.encodePairingPacket(pairing.PACKET_SPAKE2, bob.message));
        const cipher = new pairing.PairingCipher(bob.finish(clientMessage));
        const infoHeader = pairing.readPairingHeader(await reader.read(6));
        const plain = cipher.decrypt(await reader.read(infoHeader.length));
        if (plain) received.push(plain);
        if (!plain || behaviour === "hang-up") {
            toClient.end(new pairing.PairingError("unreachable", "The TV closed the connection."));
            return;
        }
        const reply = Buffer.alloc(pairing.PEER_INFO_BYTES);
        reply.writeUInt8(1, 0);
        reply.write("tv-guid", 1);
        const sealed = behaviour === "garbage" ? Buffer.alloc(pairing.PEER_INFO_BYTES + 16, 9) : cipher.encrypt(reply);
        toClient.push(pairing.encodePairingPacket(pairing.PACKET_PEER_INFO, sealed));
    })();
    return { channel, received, run };
}

describe("the pairing exchange", () => {
    const key = newAdbKey();
    const publicKey = androidPublicKey(key);

    it("pairs when the code is right, and the TV receives our ADB key", async () => {
        const tv = scriptedTv("123456");
        await pairing.pairOver(tv.channel, "123456", publicKey, ALICE_RANDOM);
        await tv.run;
        expect(tv.received).toHaveLength(1);
        expect(tv.received[0]?.subarray(1, 1 + publicKey.length).equals(publicKey)).toBe(true);
    });

    it("reports a wrong code when the TV hangs up on a PeerInfo it cannot read", async () => {
        const tv = scriptedTv("654321");
        await expect(pairing.pairOver(tv.channel, "123456", publicKey, ALICE_RANDOM)).rejects.toMatchObject({ reason: "wrong-code" });
        await tv.run;
        expect(tv.received).toHaveLength(0);
    });

    it("reports a wrong code when the TV's answer does not decrypt", async () => {
        const tv = scriptedTv("123456", "garbage");
        await expect(pairing.pairOver(tv.channel, "123456", publicKey, ALICE_RANDOM)).rejects.toMatchObject({ reason: "wrong-code" });
    });

    it("reports a protocol failure, not a wrong code, for a malformed answer", async () => {
        const toClient = new pairing.StreamReader();
        toClient.push(Buffer.from([7, 0, 0, 0, 0, 32]));
        const channel: pairing.PairingChannel = { write: () => undefined, read: (length) => toClient.read(length), exportKeyingMaterial: () => KEYING };
        await expect(pairing.pairOver(channel, "123456", publicKey)).rejects.toMatchObject({ reason: "protocol" });
    });
});

describe("the TLS certificate", () => {
    it("is a self-signed X.509 over the ADB key, as adb makes one", () => {
        const key = newAdbKey();
        const certificate = new X509Certificate(pairing.adbCertificate(key, new Date("2026-11-07T00:00:00Z")));
        expect(certificate.subject).toBe("C=US\nO=Android\nCN=Adb");
        expect(certificate.issuer).toBe(certificate.subject);
        expect(certificate.serialNumber).toBe("01");
        expect(certificate.verify(createPublicKey(key))).toBe(true);
        expect(certificate.publicKey.export({ format: "jwk" }).n).toBe(createPublicKey(key).export({ format: "jwk" }).n);
        expect(new Date(certificate.validTo).getUTCFullYear()).toBe(2036);
    });
});

describe("the TLS debugging port (A_STLS)", () => {
    const STLS = 0x534c5453;
    const CNXN = 0x4e584e43;
    const key = newAdbKey();

    /** A TV that answers CNXN with STLS, then CNXN once the link is on TLS - or refuses the handshake. */
    function tlsTv(accept: boolean) {
        const sent: number[] = [];
        let onTls = false;
        const opener: AdbLinkOpener = async (events) => {
            const reader = new PacketReader();
            return {
                send: (header, data) => {
                    for (const packet of reader.push(Buffer.concat([header, data]))) {
                        sent.push(packet.command);
                        if (packet.command === CNXN) queueMicrotask(() => events.data(encodePacket(STLS, 0x01000000, 0)));
                    }
                },
                close: () => undefined,
                startTls: async (certificate, pem) => {
                    expect(certificate).toContain("BEGIN CERTIFICATE");
                    expect(pem).toBe(key);
                    if (!accept) throw Object.assign(new Error("The TV did not accept this computer over TLS."), { code: "TLS_REFUSED" });
                    onTls = true;
                    queueMicrotask(() => events.data(encodePacket(CNXN, 0x01000001, 4096, Buffer.from("device::"))));
                }
            };
        };
        return { opener, sent, tls: () => onTls };
    }

    it("answers STLS, moves to TLS and takes the TV's CNXN with no AUTH", async () => {
        const tv = tlsTv(true);
        const adb = new AdbConnection({ link: tv.opener, key, certificate: pairing.adbCertificate(key), connectMs: 500, approveMs: 500, commandMs: 500 });
        await adb.open();
        expect(tv.sent).toEqual([CNXN, STLS]);
        expect(tv.tls()).toBe(true);
        adb.close();
    });

    it("fails as TLS_REFUSED when the TV does not know this key", async () => {
        const tv = tlsTv(false);
        const adb = new AdbConnection({ link: tv.opener, key, certificate: pairing.adbCertificate(key), connectMs: 500, approveMs: 500, commandMs: 500 });
        await expect(adb.open()).rejects.toMatchObject({ code: "TLS_REFUSED" });
        adb.close();
    });
});
