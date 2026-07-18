/**
 * Share and file-request URL tokens. These grant access to whoever holds the
 * link, so the raw token lives only in the URL we hand out; the database stores
 * only its SHA-256 hash and looks rows up by that hash. A leaked database dump
 * therefore cannot be replayed as working links. Tokens carry 256 bits of
 * entropy, so a fast hash is appropriate here - unlike user passwords, which are
 * low-entropy and must use a slow KDF (argon2, handled in @polaris/auth).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of entropy per token. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

/** Generate a URL-safe, high-entropy secret token to embed in a share link. */
export function generateToken(): string {
    return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Hash a token for storage/lookup. Returns lowercase hex SHA-256. */
export function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of a presented token against a stored hash. Hashing
 * the input first means both sides are fixed-length, so the compare itself never
 * leaks length, and timingSafeEqual avoids leaking how many bytes matched.
 */
export function tokenMatchesHash(presented: string, storedHash: string): boolean {
    const presentedHash = Buffer.from(hashToken(presented), "hex");
    const stored = Buffer.from(storedHash, "hex");
    if (presentedHash.length !== stored.length) return false;
    return timingSafeEqual(presentedHash, stored);
}

/** Generate a short, unambiguous human code (e.g. for invites). Excludes 0/O/1/I/L. */
export function generateShortCode(length = 8): string {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(length);
    let code = "";
    for (let i = 0; i < length; i += 1) {
        const index = bytes[i] as number;
        code += alphabet[index % alphabet.length];
    }
    return code;
}
