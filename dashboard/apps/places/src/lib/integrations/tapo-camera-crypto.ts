/**
 * The arithmetic of a Tapo camera's local sign-in, with nothing that talks to
 * the network, so every value can be checked against a recorded one.
 *
 * Follows pytapo's transport (`pytapo/transport/pytapo/pytapo.py`), which is
 * what the Home Assistant integration runs against these cameras. Two
 * generations of firmware are covered:
 *
 * - The old one: a login carrying the MD5 of the password, answered with a
 *   session token, and requests in clear after it.
 * - "encrypt_type 3": the camera answers the first login with a nonce and a
 *   proof that it knows the password, the second login sends a digest, and every
 *   request after it is AES-128-CBC inside `securePassthrough`, signed with a
 *   `Tapo_tag` over the body and a sequence number.
 *
 * The newest firmware (TPAP, a SPAKE2+ login) is in `tapo-tpap-crypto.ts`.
 *
 * Server-only.
 */

import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

export type PasswordHash = "md5" | "sha256";

function sha256Upper(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();
}

/** The password the way the camera hashes it: upper-case hex. */
export function hashedPassword(password: string, hash: PasswordHash): string {
    return createHash(hash).update(password, "utf8").digest("hex").toUpperCase();
}

/**
 * Which hash the camera used in its `device_confirm`, or null when neither
 * matches - which means the password is not the one the camera holds.
 *
 * Matching it is the camera proving it knows the password before anything is
 * sent to it, so a different device at that address learns nothing.
 */
export function confirmedHash(
    password: string,
    cnonce: string,
    nonce: string,
    deviceConfirm: string
): PasswordHash | null {
    for (const hash of ["sha256", "md5"] as const) {
        const expected = sha256Upper(cnonce + hashedPassword(password, hash) + nonce) + nonce + cnonce;
        if (expected === deviceConfirm) return hash;
    }
    return null;
}

/** The second login's `digest_passwd`. */
export function digestPassword(hashed: string, cnonce: string, nonce: string): string {
    return sha256Upper(hashed + cnonce + nonce) + cnonce + nonce;
}

/** The AES key (`lsk`) or IV (`ivb`) of an encrypted session. */
export function sessionToken(
    label: "lsk" | "ivb",
    hashed: string,
    cnonce: string,
    nonce: string
): Buffer {
    const key = sha256Upper(cnonce + hashed + nonce);
    return createHash("sha256")
        .update(label + cnonce + nonce + key, "utf8")
        .digest()
        .subarray(0, 16);
}

/** The `Tapo_tag` header over exactly the body that is sent. */
export function requestTag(hashed: string, cnonce: string, body: string, seq: number): string {
    return sha256Upper(sha256Upper(hashed + cnonce) + body + String(seq));
}

/** One encrypted session: what `securePassthrough` needs to wrap a request and
 *  unwrap the answer. */
export interface SecureSession {
    readonly hashed: string;
    readonly cnonce: string;
    readonly key: Buffer;
    readonly iv: Buffer;
}

export function secureSession(hashed: string, cnonce: string, nonce: string): SecureSession {
    return {
        hashed,
        cnonce,
        key: sessionToken("lsk", hashed, cnonce, nonce),
        iv: sessionToken("ivb", hashed, cnonce, nonce)
    };
}

/** A request as `securePassthrough` carries it. Node's AES-CBC pads with PKCS#7,
 *  which is what the camera expects. */
export function encryptRequest(session: SecureSession, request: string): string {
    const cipher = createCipheriv("aes-128-cbc", session.key, session.iv);
    return Buffer.concat([cipher.update(request, "utf8"), cipher.final()]).toString("base64");
}

/** The camera's encrypted answer, back to text. Throws on a wrong key, which is
 *  a session the camera no longer holds. */
export function decryptResponse(session: SecureSession, response: string): string {
    const decipher = createDecipheriv("aes-128-cbc", session.key, session.iv);
    return Buffer.concat([
        decipher.update(Buffer.from(response, "base64")),
        decipher.final()
    ]).toString("utf8");
}
