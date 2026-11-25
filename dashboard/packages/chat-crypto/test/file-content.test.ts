import { describe, expect, it } from "vitest";
import { FILE_CHUNK_BYTES, FileOpenError, fileDigest, openFile, sealFile, sealedFileSize } from "../src/file-content";

const bytes = (length: number, seed = 7): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xff);
const TAG = 16;

describe("sealed chat files", () => {
    it("round-trips empty, small, chunk-sized and multi-chunk files", async () => {
        for (const length of [0, 1, FILE_CHUNK_BYTES - 1, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES + 1, 3 * FILE_CHUNK_BYTES + 5]) {
            const plain = bytes(length);
            const file = await sealFile(plain);
            expect(file.sealed.length).toBe(sealedFileSize(length));
            expect(file.key.length).toBe(32);
            expect(file.digest).toEqual(await fileDigest(plain));
            expect(await openFile(file.key, file.sealed, file.digest)).toEqual(plain);
        }
    });

    it("uses a fresh key per file, so the same bytes never seal the same", async () => {
        const plain = bytes(1000);
        const [a, b] = await Promise.all([sealFile(plain), sealFile(plain)]);
        expect(a.key).not.toEqual(b.key);
        expect(a.sealed).not.toEqual(b.sealed);
    });

    it("does not open under another key, with another digest, or with a flipped byte", async () => {
        const plain = bytes(2 * FILE_CHUNK_BYTES + 3);
        const file = await sealFile(plain);
        const other = await sealFile(bytes(10, 9));
        await expect(openFile(other.key, file.sealed, file.digest)).rejects.toBeInstanceOf(FileOpenError);
        await expect(openFile(file.key, file.sealed, other.digest)).rejects.toBeInstanceOf(FileOpenError);
        const flipped = file.sealed.slice();
        flipped[FILE_CHUNK_BYTES + 40] ^= 1;
        await expect(openFile(file.key, flipped, file.digest)).rejects.toBeInstanceOf(FileOpenError);
        const version = file.sealed.slice();
        version[0] = 2;
        await expect(openFile(file.key, version, file.digest)).rejects.toBeInstanceOf(FileOpenError);
    });

    it("refuses a blob cut at a chunk boundary, chunks swapped, or a chunk appended", async () => {
        const plain = bytes(3 * FILE_CHUNK_BYTES);
        const file = await sealFile(plain);
        const sealedChunk = FILE_CHUNK_BYTES + TAG;
        // Cut after two whole chunks: every chunk opens, but none is flagged last.
        const cut = file.sealed.subarray(0, 1 + 2 * sealedChunk);
        await expect(openFile(file.key, cut, await fileDigest(plain.subarray(0, 2 * FILE_CHUNK_BYTES)))).rejects.toBeInstanceOf(FileOpenError);
        const swapped = file.sealed.slice();
        swapped.set(file.sealed.subarray(1, 1 + sealedChunk), 1 + sealedChunk);
        swapped.set(file.sealed.subarray(1 + sealedChunk, 1 + 2 * sealedChunk), 1);
        await expect(openFile(file.key, swapped, file.digest)).rejects.toBeInstanceOf(FileOpenError);
        const appended = new Uint8Array(file.sealed.length + sealedChunk);
        appended.set(file.sealed);
        appended.set(file.sealed.subarray(1, 1 + sealedChunk), file.sealed.length);
        await expect(openFile(file.key, appended, file.digest)).rejects.toBeInstanceOf(FileOpenError);
        await expect(openFile(file.key, file.sealed.subarray(0, 10), file.digest)).rejects.toBeInstanceOf(FileOpenError);
    });

    it("refuses a malformed key or size", async () => {
        await expect(openFile(new Uint8Array(16), new Uint8Array(40), new Uint8Array(32))).rejects.toBeInstanceOf(FileOpenError);
        expect(() => sealedFileSize(-1)).toThrow(RangeError);
    });
});
