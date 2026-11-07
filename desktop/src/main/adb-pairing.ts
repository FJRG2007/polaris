/**
 * Android 11+ Wireless debugging pairing: the six-digit code shown on the TV
 * makes it trust this computer's ADB key, so the TLS debugging port then lets
 * it in. Spoken directly, so nobody has to install platform-tools.
 *
 * Protocol as AOSP implements it (packages/modules/adb):
 * - pairing_connection/pairing_connection.cpp: TLS 1.3 to the pairing port with
 *   any certificate accepted, then 64 bytes of exported keying material (label
 *   "adb-label" with its NUL, no context) appended to the code as the password;
 *   packets are a 6-byte header (version 1, type, big-endian length) and payload.
 * - pairing_auth/pairing_auth.cpp, aes_128_gcm.cpp: SPAKE2 (adb-spake2.ts), then
 *   HKDF-SHA256 of its key into an AES-128-GCM key; the nonce is a per-direction
 *   64-bit counter in the first 8 bytes, little-endian.
 * - PeerInfo: 8192 bytes, a type byte then the data; ours carries the ADB public
 *   key, the TV answers with its GUID. A wrong code shows up here, as a PeerInfo
 *   neither side can decrypt.
 * - crypto/x509_generator.cpp: the TLS certificate is self-signed over the same
 *   RSA key, which is what the TLS debugging port later checks (A_STLS).
 */

import { CLIENT_NAME, SERVER_NAME, Spake2 } from "./adb-spake2";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createCipheriv, createDecipheriv, createPublicKey, hkdfSync, sign } from "node:crypto";

const HEADER_VERSION = 1;
export const PACKET_SPAKE2 = 0;
export const PACKET_PEER_INFO = 1;
const HEADER_BYTES = 6;
export const PEER_INFO_BYTES = 8192;
const MAX_PAYLOAD = PEER_INFO_BYTES * 2;
const PEER_RSA_KEY = 0;
const GCM_TAG_BYTES = 16;
const GCM_INFO = Buffer.from("adb pairing_auth aes-128-gcm key");
export const EXPORTED_LABEL = "adb-label\0";
export const EXPORTED_BYTES = 64;

/** Why a pairing ended without the TV trusting this computer. */
export type PairingFailure = "wrong-code" | "timeout" | "cancelled" | "unreachable" | "protocol";

export class PairingError extends Error {
    constructor(readonly reason: PairingFailure, message: string) {
        super(message);
        this.name = "PairingError";
    }
}

/** The code exactly as the TV shows it: six digits. Spaces a person typed are dropped. */
export function readPairingCode(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const code = raw.replace(/\s+/g, "");
    return /^\d{6}$/.test(code) ? code : null;
}

export function encodePairingPacket(type: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt8(HEADER_VERSION, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payload.length, 2);
    return Buffer.concat([header, payload]);
}

/** Reads one header as adbd checks it: a known version and type, and a length that is neither zero nor too large. */
export function readPairingHeader(header: Buffer): { readonly type: number; readonly length: number; } {
    if (header.length !== HEADER_BYTES) throw new PairingError("protocol", "Short pairing header.");
    const version = header.readUInt8(0);
    const type = header.readUInt8(1);
    const length = header.readUInt32BE(2);
    if (version !== HEADER_VERSION) throw new PairingError("protocol", `Unsupported pairing version ${version}.`);
    if (type !== PACKET_SPAKE2 && type !== PACKET_PEER_INFO) throw new PairingError("protocol", `Unknown pairing packet ${type}.`);
    if (length === 0 || length > MAX_PAYLOAD) throw new PairingError("protocol", `Pairing packet of ${length} bytes.`);
    return { type, length };
}

/** Our PeerInfo: the ADB public key (Android's format, with its NUL), zero-padded to 8192 bytes. */
export function peerInfo(publicKey: Buffer): Buffer {
    if (publicKey.length > PEER_INFO_BYTES - 1) throw new Error("The ADB public key does not fit a PeerInfo.");
    const info = Buffer.alloc(PEER_INFO_BYTES);
    info.writeUInt8(PEER_RSA_KEY, 0);
    publicKey.copy(info, 1);
    return info;
}

/** AES-128-GCM keyed from the SPAKE2 key, one counter per direction (aes_128_gcm.cpp). */
export class PairingCipher {
    private readonly key: Buffer;
    private sent = 0n;
    private received = 0n;

    constructor(keyMaterial: Buffer) {
        this.key = Buffer.from(hkdfSync("sha256", keyMaterial, Buffer.alloc(0), GCM_INFO, 16));
    }

    private static nonce(sequence: bigint): Buffer {
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64LE(sequence, 0);
        return nonce;
    }

    encrypt(plain: Buffer): Buffer {
        const cipher = createCipheriv("aes-128-gcm", this.key, PairingCipher.nonce(this.sent));
        this.sent += 1n;
        return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    }

    /** Null when the data does not authenticate: the two sides did not derive the same key. */
    decrypt(sealed: Buffer): Buffer | null {
        if (sealed.length < GCM_TAG_BYTES) return null;
        const decipher = createDecipheriv("aes-128-gcm", this.key, PairingCipher.nonce(this.received));
        decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
        try {
            const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
            this.received += 1n;
            return plain;
        } catch {
            return null;
        }
    }
}

/** The TLS side of a pairing, as the exchange needs it. */
export interface PairingChannel {
    write(data: Buffer): void;
    /** Exactly `length` bytes; rejects when the peer closes first. */
    read(length: number): Promise<Buffer>;
    /** RFC 5705 keying material of this TLS session. */
    exportKeyingMaterial(length: number, label: string): Buffer;
}

async function readPacket(channel: PairingChannel, expected: number): Promise<Buffer> {
    const { type, length } = readPairingHeader(await channel.read(HEADER_BYTES));
    if (type !== expected) throw new PairingError("protocol", `Expected pairing packet ${expected}, got ${type}.`);
    return channel.read(length);
}

/**
 * The client half of one pairing over an established TLS channel. Resolves once
 * the TV answered with its own PeerInfo, which only happens when it decrypted
 * ours - that is, when the code was right.
 */
export async function pairOver(channel: PairingChannel, code: string, publicKey: Buffer, random?: Uint8Array): Promise<void> {
    const password = Buffer.concat([Buffer.from(code, "utf8"), channel.exportKeyingMaterial(EXPORTED_BYTES, EXPORTED_LABEL)]);
    const spake = new Spake2("alice", CLIENT_NAME, SERVER_NAME, password, random);
    channel.write(encodePairingPacket(PACKET_SPAKE2, spake.message));
    const cipher = new PairingCipher(spake.finish(await readPacket(channel, PACKET_SPAKE2)));
    channel.write(encodePairingPacket(PACKET_PEER_INFO, cipher.encrypt(peerInfo(publicKey))));
    let sealed: Buffer;
    try {
        sealed = await readPacket(channel, PACKET_PEER_INFO);
    } catch (caught) {
        // adbd hangs up on a PeerInfo it cannot decrypt, which is what a wrong code looks like from here.
        if (!(caught instanceof PairingError) || caught.reason !== "unreachable") throw caught;
        throw new PairingError("wrong-code", "The TV did not accept the pairing code.");
    }
    const theirs = cipher.decrypt(sealed);
    if (!theirs || theirs.length !== PEER_INFO_BYTES) throw new PairingError("wrong-code", "The TV did not accept the pairing code.");
}

/** Bytes off a stream, handed out in exact lengths. */
export class StreamReader {
    private pending = Buffer.alloc(0);
    private want: { length: number; resolve: (data: Buffer) => void; reject: (error: Error) => void; } | null = null;
    private ended: Error | null = null;

    push(chunk: Buffer): void {
        this.pending = Buffer.concat([this.pending, chunk]);
        this.settle();
    }

    end(error: Error): void {
        this.ended ??= error;
        this.settle();
    }

    private settle(): void {
        const want = this.want;
        if (!want) return;
        if (this.pending.length >= want.length) {
            this.want = null;
            const data = this.pending.subarray(0, want.length);
            this.pending = this.pending.subarray(want.length);
            want.resolve(Buffer.from(data));
        } else if (this.ended) {
            this.want = null;
            want.reject(this.ended);
        }
    }

    read(length: number): Promise<Buffer> {
        if (this.want) return Promise.reject(new Error("One read at a time."));
        return new Promise((resolve, reject) => {
            this.want = { length, resolve, reject };
            this.settle();
        });
    }
}

function derLength(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const SHA256_WITH_RSA = der(0x30, der(0x06, Buffer.from("2a864886f70d01010b", "hex")), der(0x05));

function derTime(date: Date): Buffer {
    const text = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${text.slice(2)}Z`)) : der(0x18, Buffer.from(`${text}Z`));
}

/**
 * A self-signed X.509 v3 certificate over `keyPem` (RSA), as adb's
 * x509_generator.cpp makes one: serial 1, ten years, subject C=US, O=Android,
 * CN=Adb, SHA-256 with RSA. The TV reads only the public key out of it.
 */
export function adbCertificate(keyPem: string, now = new Date()): string {
    const attribute = (oid: string, value: string) =>
        der(0x31, der(0x30, der(0x06, Buffer.from(oid, "hex")), der(0x13, Buffer.from(value))));
    const name = der(0x30, attribute("550406", "US"), attribute("55040a", "Android"), attribute("550403", "Adb"));
    const later = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);
    const spki = createPublicKey(keyPem).export({ type: "spki", format: "der" });
    const tbs = der(
        0x30,
        der(0xa0, der(0x02, Buffer.from([2]))),
        der(0x02, Buffer.from([1])),
        SHA256_WITH_RSA,
        name,
        der(0x30, derTime(now), derTime(later)),
        name,
        spki
    );
    const signature = sign("sha256", tbs, keyPem);
    const certificate = der(0x30, tbs, SHA256_WITH_RSA, der(0x03, Buffer.from([0]), signature));
    const body = certificate.toString("base64").replace(/.{1,64}/g, "$&\n");
    return `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`;
}

export interface PairOptions {
    readonly host: string;
    readonly port: number;
    readonly code: string;
    /** PEM, the same key the install connects with. */
    readonly key: string;
    readonly publicKey: Buffer;
    readonly timeoutMs: number;
    /** Ends a pairing in progress; it then fails as "cancelled". */
    readonly signal?: AbortSignal;
}

/** Pairs with the TV at `host`:`port` (its `_adb-tls-pairing._tcp` port). */
export function pairTv(options: PairOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        const reader = new StreamReader();
        let settled = false;
        let socket: TLSSocket | null = null;
        const finish = (error: PairingError | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            socket?.destroy();
            if (error) reject(error);
            else resolve();
        };
        const abort = () => finish(new PairingError("cancelled", "The pairing was stopped."));
        const timer = setTimeout(() => finish(new PairingError("timeout", "The TV stopped answering.")), options.timeoutMs);
        if (options.signal?.aborted) return abort();
        options.signal?.addEventListener("abort", abort);
        let secure = false;
        socket = tlsConnect({
            host: options.host,
            port: options.port,
            cert: adbCertificate(options.key),
            key: options.key,
            // adbd's own certificate is self-signed and the code is what proves who it is.
            rejectUnauthorized: false,
            minVersion: "TLSv1.3",
            maxVersion: "TLSv1.3"
        });
        socket.on("data", (chunk: Buffer) => reader.push(chunk));
        socket.on("close", () => reader.end(new PairingError("unreachable", "The TV closed the connection.")));
        socket.on("error", (error) => {
            reader.end(new PairingError("unreachable", error.message));
            if (!secure) finish(new PairingError("unreachable", error.message));
        });
        socket.once("secureConnect", () => {
            secure = true;
            const tls = socket as TLSSocket;
            pairOver(
                {
                    write: (data) => tls.write(data),
                    read: (length) => reader.read(length),
                    // TLS 1.3 treats an empty context as none (RFC 8446 7.5), which is what adbd asks for.
                    exportKeyingMaterial: (length, label) => tls.exportKeyingMaterial(length, label, Buffer.alloc(0))
                },
                options.code,
                options.publicKey
            ).then(
                () => finish(null),
                (caught: unknown) =>
                    finish(caught instanceof PairingError ? caught : new PairingError("protocol", (caught as Error).message))
            );
        });
    });
}
