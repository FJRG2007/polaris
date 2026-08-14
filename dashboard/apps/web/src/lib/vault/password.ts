/**
 * What the server keeps of a vault's master password, and how a change to it is
 * made to end every session.
 *
 * The client never sends the password. It sends a hash derived from the master
 * key, and this hashes that again with a slow, salted KDF before it is stored -
 * the same reasoning as a link password, and the same primitive, so there is one
 * implementation of it rather than two that can drift apart.
 *
 * The value being stretched is already 256 bits of key material rather than
 * something a person typed, so the cost here is belt-and-braces: what it buys is
 * that a database dump does not hand over the value a client would present to
 * sign in. The password itself is never recoverable from anything stored.
 */

import { randomBytes } from "node:crypto";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";

/** Store what a client presented, in a form a dump cannot replay. */
export async function hashVaultPassword(clientHash: string): Promise<string> {
    return hashLinkPassword(clientHash);
}

/** Constant-time check of what a client presented against what is stored. */
export async function verifyVaultPassword(stored: string, presented: string): Promise<boolean> {
    return verifyLinkPassword(presented, stored);
}

/**
 * A fresh security stamp.
 *
 * Every access token carries the stamp its account had when it was issued, and
 * every request compares them. Moving the stamp therefore ends every session on
 * every device at once, with no list of tokens to walk - which is exactly what a
 * password change, a key rotation or a deauthorization has to do.
 */
export function newSecurityStamp(): string {
    return randomBytes(32).toString("base64url");
}
