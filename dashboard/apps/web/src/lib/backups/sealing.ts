/**
 * Encrypting a file as a stream, in chunks, so a backup of any size can be sealed
 * on its way to a destination and opened on its way back.
 *
 * Built from standard parts only: AES-256-GCM for each chunk, HKDF-SHA256 (or
 * scrypt, for a key that is a passphrase) to give every file a key of its own,
 * and the STREAM construction for the nonces - a random 7-byte prefix, a 4-byte
 * chunk counter and a final-chunk flag - so a chunk cannot be moved, repeated or
 * dropped, and the file cannot be cut short, without the open failing. The header
 * is the additional data of every chunk, so it cannot be swapped either.
 *
 * Layout: the header, then chunks of `CHUNK_BYTES` plaintext each followed by its
 * 16-byte tag. The last chunk holds 0..`CHUNK_BYTES` bytes and carries the final
 * flag; everything before it is full.
 *
 *   magic "PLRSEAL1" (8) | version (1) | kdf (1) | key id length (1) | key id |
 *   salt (32) | nonce prefix (7) | chunk bytes (4, BE) | scrypt log2 N, r, p (3, kdf 2 only)
 */

import { Transform, type TransformCallback } from "node:stream";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";

export const SEAL_MAGIC = Buffer.from("PLRSEAL1", "latin1");
const VERSION = 1;
const TAG_BYTES = 16;
const SALT_BYTES = 32;
const PREFIX_BYTES = 7;
export const CHUNK_BYTES = 64 * 1024;

/** How the file key is reached from the key that opens it. */
export type SealKdf = "keyring" | "passphrase";

/** scrypt at 2^15 x 8 x 1: 32 MiB and a fraction of a second per file. */
const SCRYPT = { log2N: 15, r: 8, p: 1 } as const;

export interface SealHeader {
    readonly kdf: SealKdf;
    /** Which key opens it: a backup key's id, or empty for a passphrase. */
    readonly keyId: string;
    readonly salt: Buffer;
    readonly prefix: Buffer;
    readonly chunkBytes: number;
    readonly scrypt?: { readonly log2N: number; readonly r: number; readonly p: number };
    /** The header exactly as written, which every chunk authenticates. */
    readonly raw: Buffer;
}

/** Raised when a sealed file cannot be opened: the wrong key, or bytes changed. */
export class SealError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "SealError";
    }
}

/** A fresh header for a file sealed under `keyId` (or a passphrase). */
export function newHeader(kdf: SealKdf, keyId = ""): SealHeader {
    const id = Buffer.from(keyId, "utf8");
    if (id.length > 255) throw new Error("A key id that long cannot be written");
    const salt = randomBytes(SALT_BYTES);
    const prefix = randomBytes(PREFIX_BYTES);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(CHUNK_BYTES);
    const parts = [
        SEAL_MAGIC,
        Buffer.from([VERSION, kdf === "keyring" ? 1 : 2, id.length]),
        id,
        salt,
        prefix,
        size,
        ...(kdf === "passphrase" ? [Buffer.from([SCRYPT.log2N, SCRYPT.r, SCRYPT.p])] : [])
    ];
    return {
        kdf,
        keyId,
        salt,
        prefix,
        chunkBytes: CHUNK_BYTES,
        ...(kdf === "passphrase" ? { scrypt: SCRYPT } : {}),
        raw: Buffer.concat(parts)
    };
}

/**
 * Read a header off the start of `bytes`, or null while there are not yet enough
 * bytes to tell. Throws when the bytes are not a sealed file at all.
 */
export function parseHeader(bytes: Buffer): SealHeader | null {
    if (bytes.length < SEAL_MAGIC.length + 3) return null;
    if (!bytes.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC))
        throw new SealError("That file is not sealed");
    const version = bytes[8];
    const kdfByte = bytes[9];
    const idLength = bytes[10] ?? 0;
    if (version !== VERSION) throw new SealError("That file was sealed by a newer Polaris");
    if (kdfByte !== 1 && kdfByte !== 2)
        throw new SealError("That file names a key kind Polaris does not know");
    const fixed = 11 + idLength + SALT_BYTES + PREFIX_BYTES + 4 + (kdfByte === 2 ? 3 : 0);
    if (bytes.length < fixed) return null;
    let at = 11;
    const keyId = bytes.subarray(at, at + idLength).toString("utf8");
    at += idLength;
    const salt = Buffer.from(bytes.subarray(at, at + SALT_BYTES));
    at += SALT_BYTES;
    const prefix = Buffer.from(bytes.subarray(at, at + PREFIX_BYTES));
    at += PREFIX_BYTES;
    const chunkBytes = bytes.readUInt32BE(at);
    at += 4;
    if (chunkBytes < 1 || chunkBytes > 16 * 1024 * 1024)
        throw new SealError("That file's chunk size is not one Polaris writes");
    let scrypt: SealHeader["scrypt"];
    if (kdfByte === 2) {
        scrypt = { log2N: bytes[at] ?? 0, r: bytes[at + 1] ?? 0, p: bytes[at + 2] ?? 0 };
        // Bounded so a crafted header cannot ask for gigabytes of memory.
        if (
            scrypt.log2N < 10 ||
            scrypt.log2N > 20 ||
            scrypt.r < 1 ||
            scrypt.r > 16 ||
            scrypt.p < 1 ||
            scrypt.p > 4
        ) {
            throw new SealError("That file's passphrase settings are out of range");
        }
    }
    return {
        kdf: kdfByte === 1 ? "keyring" : "passphrase",
        keyId,
        salt,
        prefix,
        chunkBytes,
        ...(scrypt ? { scrypt } : {}),
        raw: Buffer.from(bytes.subarray(0, fixed))
    };
}

/** Whether `bytes` - the start of a file - is a sealed one. */
export function looksSealed(bytes: Buffer): boolean {
    return (
        bytes.length >= SEAL_MAGIC.length && bytes.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)
    );
}

/** The file key under a 32-byte backup key. */
export function keyringFileKey(rootKey: Buffer, header: SealHeader): Buffer {
    if (rootKey.length !== 32) throw new Error("A backup key is 32 bytes");
    return Buffer.from(
        hkdfSync("sha256", rootKey, header.salt, Buffer.from("polaris-backup-v1"), 32)
    );
}

/** The file key under a passphrase. */
export function passphraseFileKey(passphrase: string, header: SealHeader): Buffer {
    const params = header.scrypt ?? SCRYPT;
    const N = 2 ** params.log2N;
    return scryptSync(passphrase.normalize("NFKC"), header.salt, 32, {
        N,
        r: params.r,
        p: params.p,
        maxmem: 256 * N * params.r + 1024 * 1024
    });
}

function nonceFor(header: SealHeader, counter: number, last: boolean): Buffer {
    const nonce = Buffer.alloc(12);
    header.prefix.copy(nonce, 0);
    nonce.writeUInt32BE(counter, PREFIX_BYTES);
    nonce[11] = last ? 1 : 0;
    return nonce;
}

function sealChunk(
    key: Buffer,
    header: SealHeader,
    counter: number,
    last: boolean,
    plain: Buffer
): Buffer {
    const cipher = createCipheriv("aes-256-gcm", key, nonceFor(header, counter, last));
    cipher.setAAD(header.raw);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(
    key: Buffer,
    header: SealHeader,
    counter: number,
    last: boolean,
    sealed: Buffer
): Buffer {
    if (sealed.length < TAG_BYTES) throw new SealError("That file ends in the middle of a chunk");
    const decipher = createDecipheriv("aes-256-gcm", key, nonceFor(header, counter, last));
    decipher.setAAD(header.raw);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
        return Buffer.concat([
            decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
            decipher.final()
        ]);
    } catch {
        throw new SealError("That file does not open with this key, or has been changed");
    }
}

/** A stream that seals whatever is written to it under `fileKey`, header first. */
export function sealStream(header: SealHeader, fileKey: Buffer): Transform {
    let pending = Buffer.alloc(0);
    let counter = 0;
    let started = false;
    const next = (): number => {
        if (counter >= 0xffffffff) throw new SealError("That file is too large to seal");
        return counter++;
    };
    return new Transform({
        transform(chunk: Buffer, _encoding, done: TransformCallback) {
            try {
                if (!started) {
                    this.push(header.raw);
                    started = true;
                }
                pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
                // Only a chunk known not to be the last goes now: the last one
                // carries the flag, so it waits for the end.
                while (pending.length > header.chunkBytes) {
                    this.push(
                        sealChunk(
                            fileKey,
                            header,
                            next(),
                            false,
                            pending.subarray(0, header.chunkBytes)
                        )
                    );
                    pending = pending.subarray(header.chunkBytes);
                }
                done();
            } catch (error) {
                done(error as Error);
            }
        },
        flush(done: TransformCallback) {
            try {
                if (!started) this.push(header.raw);
                this.push(sealChunk(fileKey, header, next(), true, pending));
                done();
            } catch (error) {
                done(error as Error);
            }
        }
    });
}

/**
 * A stream that opens a sealed file. `keyFor` is asked for the file key once the
 * header has been read, so the caller can look up the key it names.
 */
export function openStream(keyFor: (header: SealHeader) => Promise<Buffer> | Buffer): Transform {
    let pending = Buffer.alloc(0);
    let header: SealHeader | null = null;
    let key: Buffer | null = null;
    let counter = 0;
    let finished = false;
    const width = (): number => (header?.chunkBytes ?? 0) + TAG_BYTES;
    return new Transform({
        transform(chunk: Buffer, _encoding, done: TransformCallback) {
            pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
            void (async () => {
                if (!header) {
                    header = parseHeader(pending);
                    if (!header) return;
                    pending = pending.subarray(header.raw.length);
                    key = await keyFor(header);
                }
                // Strictly more than one chunk: the one after it proves this one
                // is not the last.
                while (pending.length > width()) {
                    this.push(
                        openChunk(
                            key as Buffer,
                            header,
                            counter++,
                            false,
                            pending.subarray(0, width())
                        )
                    );
                    pending = pending.subarray(width());
                }
            })().then(
                () => done(),
                (error: Error) => done(error)
            );
        },
        flush(done: TransformCallback) {
            try {
                if (!header || !key) throw new SealError("That file ends before its header does");
                if (!finished) {
                    this.push(openChunk(key, header, counter++, true, pending));
                    finished = true;
                }
                done();
            } catch (error) {
                done(error as Error);
            }
        }
    });
}
