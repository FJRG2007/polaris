/**
 * PKCE (RFC 7636), S256 only.
 *
 * `plain` is not accepted: a challenge equal to the verifier protects nothing
 * once the authorization request has been seen, which is the case PKCE exists
 * for. OAuth 2.1 and the MCP spec both require S256.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** 43 to 128 unreserved characters (RFC 7636 section 4.1). */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** A SHA-256 digest in base64url without padding is always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function validChallenge(challenge: string): boolean {
    return CHALLENGE.test(challenge);
}

/** Whether a verifier is the one the challenge was made from. Compared in
 *  constant time, though both sides are digests a caller already knows the
 *  length of. */
export function verifierMatches(verifier: string, challenge: string): boolean {
    if (!VERIFIER.test(verifier) || !validChallenge(challenge)) return false;
    const computed = Buffer.from(
        createHash("sha256").update(verifier, "ascii").digest("base64url")
    );
    const expected = Buffer.from(challenge);
    return computed.length === expected.length && timingSafeEqual(computed, expected);
}
