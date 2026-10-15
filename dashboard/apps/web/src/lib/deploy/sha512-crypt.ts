/**
 * SHA-512 crypt (`$6$`), the password hash `/etc/shadow` takes, so an SFTP
 * server is handed a hash and never the password itself.
 *
 * The algorithm is Ulrich Drepper's "Unix crypt using SHA-256 and SHA-512"
 * (the one glibc and musl implement), at its default 5000 rounds.
 */

import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The order the digest's bytes are encoded in, three at a time. */
const ORDER = [
    [0, 21, 42],
    [22, 43, 1],
    [44, 2, 23],
    [3, 24, 45],
    [25, 46, 4],
    [47, 5, 26],
    [6, 27, 48],
    [28, 49, 7],
    [50, 8, 29],
    [9, 30, 51],
    [31, 52, 10],
    [53, 11, 32],
    [12, 33, 54],
    [34, 55, 13],
    [56, 14, 35],
    [15, 36, 57],
    [37, 58, 16],
    [59, 17, 38],
    [18, 39, 60],
    [40, 61, 19],
    [62, 20, 41]
] as const;

function sha512(...parts: Buffer[]): Buffer {
    const hash = createHash("sha512");
    for (const part of parts) hash.update(part);
    return hash.digest();
}

/** `length` bytes of `source`, repeated as many times as it takes. */
function repeated(source: Buffer, length: number): Buffer {
    const out = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset += source.length)
        source.copy(out, offset, 0, Math.min(source.length, length - offset));
    return out;
}

function encode(value: number, characters: number): string {
    let out = "";
    for (let index = 0; index < characters; index++) {
        out += ALPHABET[value & 0x3f];
        value >>>= 6;
    }
    return out;
}

/** A random salt of 16 characters from the crypt alphabet. */
export function cryptSalt(): string {
    return Array.from(randomBytes(16), (byte) => ALPHABET[byte & 0x3f]).join("");
}

/** The `$6$<salt>$<hash>` line for a password. */
export function sha512Crypt(password: string, salt: string = cryptSalt()): string {
    const key = Buffer.from(password, "utf8");
    const saltBytes = Buffer.from(salt.slice(0, 16), "utf8");

    const alternate = sha512(key, saltBytes, key);
    const first = createHash("sha512")
        .update(key)
        .update(saltBytes)
        .update(repeated(alternate, key.length));
    for (let length = key.length; length > 0; length >>= 1)
        first.update(length & 1 ? alternate : key);
    let digest = first.digest();

    const p = repeated(sha512(...Array.from({ length: key.length }, () => key)), key.length);
    const s = repeated(
        sha512(...Array.from({ length: 16 + digest[0]! }, () => saltBytes)),
        saltBytes.length
    );

    for (let round = 0; round < 5000; round++) {
        const step = createHash("sha512");
        step.update(round & 1 ? p : digest);
        if (round % 3) step.update(s);
        if (round % 7) step.update(p);
        step.update(round & 1 ? digest : p);
        digest = step.digest();
    }

    let hash = "";
    for (const [a, b, c] of ORDER)
        hash += encode((digest[a]! << 16) | (digest[b]! << 8) | digest[c]!, 4);
    hash += encode(digest[63]!, 2);
    return `$6$${saltBytes.toString("utf8")}$${hash}`;
}
