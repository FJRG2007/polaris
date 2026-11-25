/**
 * The safety number of a pair of accounts (design 4.6): 60 digits in 12 groups
 * of 5, the same on both sides, that two people compare in person to know the
 * account keys their browsers seal to are each other's and not keys the server
 * slipped in.
 *
 * Built the way Signal's numeric fingerprint is (libsignal
 * `rust/protocol/src/fingerprint.rs`, also what WhatsApp's security code is):
 * per account, SHA-512 over a version, the public key and the account id, then
 * 5,199 more rounds of SHA-512 over the previous digest and the key; the first
 * 30 bytes, read as six big-endian 40-bit numbers mod 100,000, are that
 * account's 30 digits. Thirty digits are about 2^100 values, and the rounds
 * make every guess at a key with the same digits cost 5,200 hashes.
 *
 * Differences from Signal, on purpose: the "key" is both of the account's
 * public halves (Ed25519 and X-Wing, length-prefixed), since a substitute of
 * either is an attack; the version is this module's own, so a number never
 * reads as a Signal one; and the two halves are ordered by account id, as the
 * design says, so both browsers put them in the same order without comparing
 * the digits.
 */

import { canonical, owned } from "./bytes";
import type { AccountPublicKeys } from "./account-key";

/** Signal uses 5,200 for its safety numbers. */
export const SAFETY_ITERATIONS = 5200;
const VERSION = new Uint8Array([0x00, 0x01]);
const LABEL = "polaris/chat-e2ee/safety-number/v1";

export interface SafetyParty {
    readonly userId: string;
    readonly keys: AccountPublicKeys;
}

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
        joined.set(part, at);
        at += part.length;
    }
    return new Uint8Array(await crypto.subtle.digest("SHA-512", owned(joined)));
}

/** One account's 30 digits. */
export async function accountDigits(party: SafetyParty, iterations: number = SAFETY_ITERATIONS): Promise<string> {
    if (!Number.isInteger(iterations) || iterations < 2 || iterations > 1_000_000) throw new RangeError("iterations out of range");
    if (!party.userId) throw new RangeError("A safety number needs the account id");
    const key = canonical(LABEL, party.keys.signPublicKey, party.keys.hpkePublicKey);
    let digest = await sha512(VERSION, key, canonical(party.userId), key);
    for (let round = 1; round < iterations; round++) digest = await sha512(digest, key);
    let digits = "";
    for (let chunk = 0; chunk < 6; chunk++) {
        let value = 0;
        // 40 bits fit a double exactly; `* 256` rather than `<< 8`, which is 32-bit.
        for (let index = chunk * 5; index < chunk * 5 + 5; index++) value = value * 256 + (digest[index] ?? 0);
        digits += String(value % 100_000).padStart(5, "0");
    }
    return digits;
}

/**
 * The pair's 60 digits, with no spaces: the half of the account with the
 * smaller id first. Equal ids are refused - a number with yourself proves
 * nothing.
 */
export async function safetyNumber(a: SafetyParty, b: SafetyParty, iterations: number = SAFETY_ITERATIONS): Promise<string> {
    if (a.userId === b.userId) throw new RangeError("A safety number is between two accounts");
    const [first, second] = a.userId < b.userId ? [a, b] : [b, a];
    const [one, two] = await Promise.all([accountDigits(first, iterations), accountDigits(second, iterations)]);
    return one + two;
}

/** The 12 groups of 5 a screen shows. */
export function safetyGroups(digits: string): string[] {
    if (!/^\d{60}$/.test(digits)) throw new RangeError("A safety number is 60 digits");
    return digits.match(/\d{5}/g) ?? [];
}
