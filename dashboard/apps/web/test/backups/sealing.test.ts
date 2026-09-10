/**
 * The sealed-file format: every size round-trips, and every way of changing the
 * bytes - a flipped bit, a missing tail, chunks swapped, the wrong key, another
 * file's header - fails to open rather than yielding something.
 */

import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    CHUNK_BYTES,
    keyringFileKey,
    looksSealed,
    newHeader,
    openStream,
    passphraseFileKey,
    SealError,
    sealStream
} from "@/lib/backups/sealing";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part as Buffer);
    return Buffer.concat(parts);
}

/** Feed `bytes` in uneven pieces, the way a network stream delivers them. */
function pieces(bytes: Buffer): Readable {
    const out: Buffer[] = [];
    for (let at = 0, step = 1; at < bytes.length; at += step, step = (step * 7 + 3) % 9000 + 1) {
        out.push(bytes.subarray(at, at + step));
    }
    return Readable.from(out);
}

const root = randomBytes(32);

async function seal(plain: Buffer, key = root): Promise<Buffer> {
    const header = newHeader("keyring", "key-1");
    return collect(pieces(plain).pipe(sealStream(header, keyringFileKey(key, header))));
}

async function open(sealed: Buffer, key = root): Promise<Buffer> {
    return collect(pieces(sealed).pipe(openStream((header) => keyringFileKey(key, header))));
}

describe("sealing a file", () => {
    it.each([0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 17])(
        "round-trips %i bytes",
        async (size) => {
            const plain = randomBytes(size);
            const sealed = await seal(plain);
            expect(looksSealed(sealed)).toBe(true);
            // Nothing of the plaintext survives: a run of it long enough not to occur by chance.
            if (size >= 32) expect(sealed.includes(plain.subarray(0, 32))).toBe(false);
            expect((await open(sealed)).equals(plain)).toBe(true);
        }
    );

    it("refuses a flipped bit", async () => {
        const sealed = await seal(randomBytes(1000));
        sealed[sealed.length - 40] ^= 1;
        await expect(open(sealed)).rejects.toBeInstanceOf(SealError);
    });

    it("refuses a file cut short at a chunk boundary", async () => {
        const sealed = await seal(randomBytes(2 * CHUNK_BYTES + 5));
        const headerLength = newHeader("keyring", "key-1").raw.length;
        const withoutTail = sealed.subarray(0, headerLength + 2 * (CHUNK_BYTES + 16));
        await expect(open(withoutTail)).rejects.toBeInstanceOf(SealError);
    });

    it("refuses chunks put back in another order", async () => {
        const sealed = await seal(randomBytes(3 * CHUNK_BYTES + 1));
        const headerLength = newHeader("keyring", "key-1").raw.length;
        const width = CHUNK_BYTES + 16;
        const first = sealed.subarray(headerLength, headerLength + width);
        const second = sealed.subarray(headerLength + width, headerLength + 2 * width);
        const swapped = Buffer.concat([
            sealed.subarray(0, headerLength),
            second,
            first,
            sealed.subarray(headerLength + 2 * width)
        ]);
        await expect(open(swapped)).rejects.toBeInstanceOf(SealError);
    });

    it("refuses the wrong key", async () => {
        const sealed = await seal(randomBytes(100));
        await expect(open(sealed, randomBytes(32))).rejects.toBeInstanceOf(SealError);
    });

    it("refuses one file's body under another file's header", async () => {
        const a = await seal(randomBytes(100));
        const b = await seal(randomBytes(100));
        const headerLength = newHeader("keyring", "key-1").raw.length;
        const mixed = Buffer.concat([a.subarray(0, headerLength), b.subarray(headerLength)]);
        await expect(open(mixed)).rejects.toBeInstanceOf(SealError);
    });

    it("refuses bytes that were never sealed", async () => {
        await expect(open(Buffer.from("just a plain gzip, honest"))).rejects.toBeInstanceOf(SealError);
    });

    it("seals under a passphrase and names no key", async () => {
        const header = newHeader("passphrase");
        const plain = randomBytes(5000);
        const sealed = await collect(
            pieces(plain).pipe(sealStream(header, passphraseFileKey("correct horse battery", header)))
        );
        const opened = await collect(
            pieces(sealed).pipe(openStream((read) => passphraseFileKey("correct horse battery", read)))
        );
        expect(opened.equals(plain)).toBe(true);
        await expect(
            collect(pieces(sealed).pipe(openStream((read) => passphraseFileKey("wrong", read))))
        ).rejects.toBeInstanceOf(SealError);
    });
});
