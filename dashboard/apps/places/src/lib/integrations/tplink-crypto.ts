/**
 * The two ciphers TP-Link's plugs, bulbs and strips speak on their own network.
 *
 * Pure: bytes in, bytes out, no sockets. Kept apart from the transport so the
 * arithmetic can be checked against the reference implementation's own test
 * vectors without a device, which is the only way anybody finds out that a seed
 * is in the wrong order - the device just stops answering.
 *
 * Everything here follows python-kasa (`kasa/transports/xortransport.py` and
 * `kasa/transports/klaptransport.py`), which is where TP-Link's local protocols
 * are documented at all; TP-Link publish nothing.
 *
 * Server-only.
 */

import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The old one: an XOR with a running key, on port 9999
// ---------------------------------------------------------------------------

/** The key the running XOR starts from. */
const XOR_START = 171;

/**
 * A request as the older Kasa firmware wants it on the wire: a four-byte
 * big-endian length of the plaintext, then every byte XORed with the one before
 * it, the first with 171.
 */
export function xorEncrypt(request: string): Buffer {
    const plain = Buffer.from(request, "utf8");
    const out = Buffer.alloc(4 + plain.length);
    out.writeUInt32BE(plain.length, 0);
    let key = XOR_START;
    for (let index = 0; index < plain.length; index += 1) {
        key ^= plain[index]!;
        out[4 + index] = key;
    }
    return out;
}

/** The reverse, for a reply with its length prefix already taken off. The key
 *  for each byte is the ciphertext byte before it. */
export function xorDecrypt(cipher: Buffer): string {
    const out = Buffer.alloc(cipher.length);
    let key = XOR_START;
    for (let index = 0; index < cipher.length; index += 1) {
        const byte = cipher[index]!;
        out[index] = key ^ byte;
        key = byte;
    }
    return out.toString("utf8");
}

// ---------------------------------------------------------------------------
// The newer one: KLAP
// ---------------------------------------------------------------------------

function sha256(...parts: Buffer[]): Buffer {
    return createHash("sha256").update(Buffer.concat(parts)).digest();
}

function sha1(value: Buffer): Buffer {
    return createHash("sha1").update(value).digest();
}

function md5(value: Buffer): Buffer {
    return createHash("md5").update(value).digest();
}

/**
 * Which KLAP a device speaks.
 *
 * Not something the device says: it is decided by the family. A Kasa device on
 * newer firmware ("IOT" in their words) uses the first, md5-based version; a
 * Tapo and the newest Kasa ("SMART") use the second. Both answer the same first
 * handshake, so the version is found by whichever formula its answer matches.
 */
export type KlapVersion = 1 | 2;

/** What the account's email and password are hashed into before either side
 *  ever sees them. */
export function klapAuthHash(version: KlapVersion, username: string, password: string): Buffer {
    const user = Buffer.from(username, "utf8");
    const pass = Buffer.from(password, "utf8");
    return version === 1
        ? md5(Buffer.concat([md5(user), md5(pass)]))
        : sha256(sha1(user), sha1(pass));
}

/** What the device must answer the first handshake with, if it holds the same
 *  credentials. */
export function klapServerHash(
    version: KlapVersion,
    localSeed: Buffer,
    remoteSeed: Buffer,
    authHash: Buffer
): Buffer {
    return version === 1 ? sha256(localSeed, authHash) : sha256(localSeed, remoteSeed, authHash);
}

/** What the client sends as the second handshake, proving the same thing back. */
export function klapClientHash(
    version: KlapVersion,
    localSeed: Buffer,
    remoteSeed: Buffer,
    authHash: Buffer
): Buffer {
    return version === 1 ? sha256(remoteSeed, authHash) : sha256(remoteSeed, localSeed, authHash);
}

/** A signed 32-bit big-endian integer, which is how the sequence travels. */
function signedLong(value: number): Buffer {
    const out = Buffer.alloc(4);
    out.writeInt32BE(value, 0);
    return out;
}

/**
 * One session's cipher, derived from both seeds and the credentials.
 *
 * AES-128-CBC whose IV is twelve derived bytes followed by the sequence number,
 * which goes up by one for every request. Each request is signed with a SHA-256
 * over a derived key, the sequence and the ciphertext, and the reply to it is
 * decrypted with the same IV - nothing in the reply says which one.
 */
export class KlapSession {
    private readonly key: Buffer;
    private readonly iv: Buffer;
    private readonly signature: Buffer;
    private seq: number;

    constructor(localSeed: Buffer, remoteSeed: Buffer, authHash: Buffer) {
        this.key = sha256(Buffer.from("lsk"), localSeed, remoteSeed, authHash).subarray(0, 16);
        const fullIv = sha256(Buffer.from("iv"), localSeed, remoteSeed, authHash);
        this.iv = fullIv.subarray(0, 12);
        this.seq = fullIv.readInt32BE(28);
        this.signature = sha256(Buffer.from("ldk"), localSeed, remoteSeed, authHash).subarray(0, 28);
    }

    /** The sequence the next request will carry, for a test. */
    get sequence(): number {
        return this.seq;
    }

    private ivFor(seq: number): Buffer {
        return Buffer.concat([this.iv, signedLong(seq)]);
    }

    /** A request, as the body to post and the sequence to put in its URL. */
    encrypt(message: string): { body: Buffer; seq: number } {
        // Wraps rather than overflowing: a session is renewed long before, but
        // an int32 that stopped being one would sign the wrong bytes.
        this.seq = this.seq === 0x7fffffff ? -0x80000000 : this.seq + 1;
        const cipher = createCipheriv("aes-128-cbc", this.key, this.ivFor(this.seq));
        const ciphertext = Buffer.concat([cipher.update(message, "utf8"), cipher.final()]);
        const signature = sha256(this.signature, signedLong(this.seq), ciphertext);
        return { body: Buffer.concat([signature, ciphertext]), seq: this.seq };
    }

    /** The reply to the request that carried `seq`. Its first 32 bytes are a
     *  signature the reference implementation does not check either. */
    decrypt(body: Buffer, seq: number): string {
        const decipher = createDecipheriv("aes-128-cbc", this.key, this.ivFor(seq));
        return Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]).toString("utf8");
    }
}
