/**
 * Optional passwords that protect share links. Unlike share tokens (which carry
 * 256 bits of entropy and only need a fast hash), a link password is chosen by a
 * human and is therefore low-entropy, so it must be stretched with a slow, salted
 * KDF. We use scrypt from node:crypto - memory-hard and dependency-free - with a
 * per-password random salt, and verify in constant time. This module uses
 * node:crypto and is server-only; import it from "@polaris/core/link-password".
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** scrypt cost parameters. N must be a power of two; these are OWASP-baseline. */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Promise wrapper around the callback-style scrypt. */
function derive(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P }, (error, key) => {
            if (error) reject(error);
            else resolve(key);
        });
    });
}

/**
 * Hash a link password for storage. The returned string is self-describing
 * (`scrypt$N$r$p$salt$hash`, base64 fields) so verification needs no external
 * parameters and the cost can be raised later without breaking old hashes.
 */
export async function hashLinkPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(password, salt);
    return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Verify a presented password against a stored hash in constant time. Any
 * malformed or unknown-scheme hash returns false rather than throwing, so a
 * corrupt row can never be bypassed or crash the access path.
 */
export async function verifyLinkPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    const cost = { N: Number(nRaw), r: Number(rRaw), p: Number(pRaw) };
    if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;
    let expected: Buffer;
    try {
        expected = Buffer.from(hashRaw as string, "base64");
    } catch {
        return false;
    }
    const salt = Buffer.from(saltRaw as string, "base64");
    const key = await new Promise<Buffer | null>((resolve) => {
        scrypt(password, salt, expected.length, { N: cost.N, r: cost.r, p: cost.p }, (error, derived) =>
            resolve(error ? null : derived)
        );
    });
    if (!key || key.length !== expected.length) return false;
    return timingSafeEqual(key, expected);
}
