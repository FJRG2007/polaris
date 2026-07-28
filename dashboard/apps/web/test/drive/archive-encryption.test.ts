/**
 * Reading "this archive needs a password" out of an archive's first bytes.
 *
 * Two failures matter and they are not symmetric: marking a plain archive as
 * locked misleads, so the zip cases run against archives produced by the same
 * writers Polaris itself uses rather than hand-made bytes; and a head that
 * cannot be understood must come back as "unknown" (null) instead of a guess.
 * The rar cases are byte-level because the format states it in a header field
 * and there is no rar writer in the stack to generate one.
 */

import { describe, expect, it } from "vitest";
import * as archiverModule from "archiver";
import archiverZipEncrypted from "archiver-zip-encrypted";
import JSZip from "jszip";
import {
    detectEncryptionFromHead,
    isProbableArchive
} from "../../src/lib/drive-archive-encryption";

// archiver is a CommonJS callable exported with `export =`; under ESM it arrives
// on the namespace's default binding.
const archiver = ((archiverModule as { default?: unknown }).default ??
    archiverModule) as unknown as {
    (format: string, options?: Record<string, unknown>): archiverModule.Archiver;
    registerFormat(name: string, mod: unknown): void;
};

/** Build a real AES-256 password-protected zip in memory. */
async function encryptedZip(): Promise<Uint8Array> {
    archiver.registerFormat("zip-encrypted", archiverZipEncrypted);
    const archive = archiver("zip-encrypted", {
        zlib: { level: 1 },
        encryptionMethod: "aes256",
        password: "correct horse"
    });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
        archive.on("end", () => resolve());
        archive.on("error", reject);
    });
    archive.append(Buffer.from("secret contents"), { name: "notes.txt" });
    await archive.finalize();
    await done;
    return new Uint8Array(Buffer.concat(chunks));
}

/** Build a plain zip in memory. */
async function plainZip(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("notes.txt", "plain contents");
    return new Uint8Array(await zip.generateAsync({ type: "nodebuffer" }));
}

/** Assemble a rar4 archive head: signature, main header, then one file header. */
function rar4Head(mainFlags: number, fileFlags: number): Uint8Array {
    const bytes = new Uint8Array(64);
    bytes.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], 0);
    const view = new DataView(bytes.buffer);
    // Main header: crc(2) type(1) flags(2) size(2), 13 bytes in total.
    view.setUint8(9, 0x73);
    view.setUint16(10, mainFlags, true);
    view.setUint16(12, 13, true);
    // File header at 7 + 13 = 20.
    view.setUint8(22, 0x74);
    view.setUint16(23, fileFlags, true);
    view.setUint16(25, 32, true);
    return bytes;
}

/** A rar5 head whose first block is the encryption header (type 4). */
function rar5EncryptedHead(): Uint8Array {
    const bytes = new Uint8Array(32);
    bytes.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], 0);
    bytes[12] = 0x10; // header size
    bytes[13] = 0x04; // header type: encryption
    return bytes;
}

/**
 * A rar5 head with a main header followed by one file header. `encrypted` adds
 * the extra area holding an encryption record (record type 1).
 */
function rar5FileHead(encrypted: boolean): Uint8Array {
    const bytes = new Uint8Array(64);
    bytes.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], 0);
    // Main header: crc at 8..11, size 8 (so the block ends at 21), type 1, flags 0.
    bytes[12] = 0x08;
    bytes[13] = 0x01;
    bytes[14] = 0x00;
    // File header at 21: crc at 21..24, size at 25, type at 26.
    bytes[25] = 0x14; // header size 20 -> the block body ends at 46
    bytes[26] = 0x02; // file header
    if (!encrypted) {
        bytes[27] = 0x00; // no extra area, so nothing can declare encryption
        return bytes;
    }
    bytes[27] = 0x01; // extra area present
    bytes[28] = 0x04; // extra area size
    bytes[29] = 0x00; // file flags
    bytes[30] = 0x05; // unpacked size
    bytes[31] = 0x20; // attributes
    bytes[32] = 0x30; // compression info
    bytes[33] = 0x00; // host os
    bytes[34] = 0x05; // name length
    bytes.set([0x61, 0x2e, 0x74, 0x78, 0x74, 0x00], 35); // "a.txt"
    bytes[40] = 0x02; // extra record size
    bytes[41] = 0x01; // record type 1: file encryption
    return bytes;
}

describe("detectEncryptionFromHead", () => {
    it("recognizes a password-protected zip", async () => {
        expect(detectEncryptionFromHead(await encryptedZip())).toBe(true);
    });

    it("leaves a plain zip unmarked", async () => {
        expect(detectEncryptionFromHead(await plainZip())).toBe(false);
    });

    it("reads the rar4 archive and file password flags", () => {
        expect(detectEncryptionFromHead(rar4Head(0x0000, 0x0000))).toBe(false);
        expect(detectEncryptionFromHead(rar4Head(0x0080, 0x0000))).toBe(true);
        expect(detectEncryptionFromHead(rar4Head(0x0000, 0x0004))).toBe(true);
    });

    it("recognizes rar5 encrypted headers and encrypted files", () => {
        expect(detectEncryptionFromHead(rar5EncryptedHead())).toBe(true);
        expect(detectEncryptionFromHead(rar5FileHead(true))).toBe(true);
        expect(detectEncryptionFromHead(rar5FileHead(false))).toBe(false);
    });

    it("says nothing when the head is not an archive it can read", () => {
        expect(detectEncryptionFromHead(new Uint8Array([1, 2, 3]))).toBeNull();
        expect(detectEncryptionFromHead(new Uint8Array(64))).toBeNull();
        // A 7z head is a real archive, but its format is not one this can answer.
        const sevenZip = new Uint8Array(64);
        sevenZip.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 0);
        expect(detectEncryptionFromHead(sevenZip)).toBeNull();
    });
});

describe("isProbableArchive", () => {
    it("only claims the formats whose head can be read", () => {
        expect(isProbableArchive("photos.zip")).toBe(true);
        expect(isProbableArchive("backup.RAR")).toBe(true);
        expect(isProbableArchive("dump.7z")).toBe(false);
        expect(isProbableArchive("notes.txt")).toBe(false);
    });
});
