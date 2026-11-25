/**
 * A chat file sealed in the browser (docs/chat-e2ee-proposal.md 10b.2): the
 * server and the storage behind it (a NAS, a connection) hold only an opaque
 * blob and its size. The key and the SHA-256 of the clear bytes travel inside
 * the sealed message that names the file, so whoever can open the message can
 * open the file, and nobody else can.
 *
 *     key      = 32 random bytes, one per file (never derived from the content:
 *                convergent encryption would let a server confirm who holds a
 *                known file, 10b.2)
 *     sealed   = version(1) || chunk_0 || ... || chunk_n
 *     chunk_i  = AES-256-GCM(key, nonce_i, plain[i * 64 KiB, 64 KiB], aad = version || LABEL)
 *     nonce_i  = 0^7 || uint32_be(i) || last(1)
 *
 * The nonce is a counter (a fresh key per file makes a fixed prefix safe, and
 * no nonce repeats under one key), and the last chunk is flagged inside its
 * nonce (the STREAM construction), so a blob cut at a chunk boundary, chunks
 * swapped or a chunk appended do not open. The digest of the clear bytes is
 * checked after opening, so a blob swapped for another file sealed under the
 * same key does not pass either.
 */

import { concat, owned, randomBytes } from "./bytes";

export const FILE_CONTENT_VERSION = 1;
export const FILE_KEY_BYTES = 32;
export const FILE_DIGEST_BYTES = 32;
/** Clear bytes per chunk. */
export const FILE_CHUNK_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
/** The most chunks a counter numbers (a 256 TiB file; chat refuses far less). */
const MAX_CHUNKS = 0xffffffff;
const LABEL = new TextEncoder().encode("polaris/chat-e2ee/file/v1");

export class FileOpenError extends Error {
    constructor() {
        super("The file could not be opened");
        this.name = "FileOpenError";
    }
}

/** One file as sealed: what the message carries (`key`, `digest`) and what is uploaded (`sealed`). */
export interface SealedFile {
    readonly key: Uint8Array;
    readonly digest: Uint8Array;
    readonly sealed: Uint8Array;
}

/** How many bytes a file of `plainSize` bytes takes once sealed. */
export function sealedFileSize(plainSize: number): number {
    if (!Number.isSafeInteger(plainSize) || plainSize < 0) throw new RangeError("A size is a whole number of bytes");
    return 1 + chunkCount(plainSize) * TAG_BYTES + plainSize;
}

const chunkCount = (plainSize: number): number => Math.max(1, Math.ceil(plainSize / FILE_CHUNK_BYTES));

function nonce(index: number, last: boolean): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(NONCE_BYTES);
    new DataView(out.buffer).setUint32(7, index, false);
    out[11] = last ? 1 : 0;
    return out;
}

const aad = (): Uint8Array<ArrayBuffer> => owned(concat(Uint8Array.of(FILE_CONTENT_VERSION), LABEL));

async function aesKey(key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
    if (key.length !== FILE_KEY_BYTES) throw new RangeError("A file key is 32 bytes");
    return crypto.subtle.importKey("raw", owned(key), "AES-GCM", false, [usage]);
}

/** SHA-256 of the clear bytes, as the sealed message carries it. */
export async function fileDigest(plaintext: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", owned(plaintext)));
}

/** Seal one file under a fresh key; answers the key and digest for the message, and the bytes to upload. */
export async function sealFile(plaintext: Uint8Array): Promise<SealedFile> {
    const chunks = chunkCount(plaintext.length);
    if (chunks > MAX_CHUNKS) throw new RangeError("That file is too big to seal");
    const key = randomBytes(FILE_KEY_BYTES);
    const cipher = await aesKey(key, "encrypt");
    const additionalData = aad();
    const out = new Uint8Array(sealedFileSize(plaintext.length));
    out[0] = FILE_CONTENT_VERSION;
    let at = 1;
    for (let index = 0; index < chunks; index++) {
        const part = plaintext.subarray(index * FILE_CHUNK_BYTES, (index + 1) * FILE_CHUNK_BYTES);
        const iv = nonce(index, index === chunks - 1);
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, cipher, owned(part)));
        out.set(sealed, at);
        at += sealed.length;
    }
    return { key, digest: await fileDigest(plaintext), sealed: out };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
    return diff === 0;
}

/** Open a file sealed by `sealFile` and check it is the one the message named; one coarse error for every failure. */
export async function openFile(key: Uint8Array, sealed: Uint8Array, digest: Uint8Array): Promise<Uint8Array> {
    if (sealed.length < 1 + TAG_BYTES || sealed[0] !== FILE_CONTENT_VERSION || digest.length !== FILE_DIGEST_BYTES) throw new FileOpenError();
    try {
        const cipher = await aesKey(key, "decrypt");
        const additionalData = aad();
        const body = sealed.subarray(1);
        const sealedChunk = FILE_CHUNK_BYTES + TAG_BYTES;
        const chunks = Math.ceil(body.length / sealedChunk);
        const out = new Uint8Array(body.length - chunks * TAG_BYTES);
        let at = 0;
        for (let index = 0; index < chunks; index++) {
            const part = body.subarray(index * sealedChunk, (index + 1) * sealedChunk);
            const iv = nonce(index, index === chunks - 1);
            const opened = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, cipher, owned(part)));
            out.set(opened, at);
            at += opened.length;
        }
        if (!sameBytes(await fileDigest(out), digest)) throw new FileOpenError();
        return out;
    } catch {
        throw new FileOpenError();
    }
}
