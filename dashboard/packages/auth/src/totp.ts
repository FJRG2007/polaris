/**
 * Checking an authenticator code for an account that has no session yet.
 *
 * better-auth verifies TOTP through an endpoint that resolves the account from a
 * session or from its own sign-in challenge cookie. The vault has neither: a
 * Bitwarden client posts a master password hash and a six-digit code to one
 * endpoint, over an API, with nothing else to go on.
 *
 * So the same check is done here against the same stored secret. The secret is
 * decrypted with better-auth's own function - the encryption is the library's
 * and a second implementation of it would be a second thing to keep in step -
 * and the code itself is plain RFC 6238, computed with node:crypto rather than
 * by reaching into a transitive dependency.
 *
 * The parameters below are not choices; they are what the plugin generates codes
 * with, and a mismatch means an authenticator that never works.
 */

import { prisma } from "@polaris/db";
import { createHmac } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { symmetricDecrypt } from "better-auth/crypto";

/** Seconds a code is good for. */
const PERIOD = 30;
/** Digits in a code. */
const DIGITS = 6;
/**
 * How many steps either side of now are accepted.
 *
 * One, matching the plugin: it covers a phone whose clock is a little out and a
 * person who started typing as the code turned over, and it is the smallest
 * window that does. Widening it multiplies the codes valid at any moment.
 */
const WINDOW = 1;

/** One code, for a given 30-second step. */
function hotp(secret: string, counter: number): string {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac("sha1", Buffer.from(secret, "utf8")).update(message).digest();
    // Dynamic truncation, RFC 4226 section 5.4.
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary =
        ((digest[offset]! & 0x7f) << 24) |
        ((digest[offset + 1]! & 0xff) << 16) |
        ((digest[offset + 2]! & 0xff) << 8) |
        (digest[offset + 3]! & 0xff);
    return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * Whether a code matches the account's authenticator right now.
 *
 * False for every kind of no: no authenticator armed, one that was never
 * verified, a stored secret this instance cannot read, or a wrong code. The
 * caller answers all of them the same way, because telling them apart tells
 * somebody guessing which part of their guess was wrong.
 *
 * This does NOT rate-limit. It is one check, and the endpoint that calls it owns
 * how many times it may be asked - counting attempts here would spread that
 * decision across two places.
 */
export async function verifyTotpForUser(userId: string, code: string): Promise<boolean> {
    const trimmed = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(trimmed)) return false;

    const row = await prisma.twoFactor.findFirst({
        where: { userId, verified: true },
        select: { secret: true }
    });
    if (!row) return false;

    let secret: string;
    try {
        secret = await symmetricDecrypt({ key: loadEnv().POLARIS_AUTH_SECRET, data: row.secret });
    } catch {
        return false;
    }

    const step = Math.floor(Date.now() / (PERIOD * 1000));
    let matched = false;
    for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
        // A counter is unsigned, and the step before the first one does not
        // exist. Only reachable with a clock set to the epoch, but it throws
        // rather than failing the check, which is the wrong shape of no.
        const counter = step + offset;
        if (counter < 0) continue;
        // Every step is checked even after one matches, so how long this takes
        // does not say which step it was - the same shape the plugin uses.
        matched = hotp(secret, counter) === trimmed || matched;
    }
    return matched;
}
