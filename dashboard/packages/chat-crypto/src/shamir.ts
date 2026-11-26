/**
 * Shamir secret sharing over GF(2^8), byte by byte, from the audited
 * `shamir-secret-sharing` package (privy-io; Cure53 and Zellic audits), vendored
 * in `./vendor/shamir-secret-sharing` with its licence and a note of the exact
 * version and tarball integrity. The AES field, x^8 + x^4 + x^3 + x + 1.
 *
 *     share = y(secret.length) || x(1)
 *
 * The package refuses a threshold or a share count below 2. Recovery needs
 * 1 of 1 (an organisation with a single administrator), so a threshold of 1 is
 * handled here as the degree-0 polynomial it is - every share is the secret
 * behind its own x - and a single share is read the same way. Everything else
 * goes to the package untouched.
 */

import { randomBytes } from "./bytes";
import * as audited from "./vendor/shamir-secret-sharing/index";

/** `parts` shares, any `threshold` of which give `secret` back. */
export async function split(secret: Uint8Array, parts: number, threshold: number): Promise<Uint8Array[]> {
    if (!Number.isInteger(parts) || !Number.isInteger(threshold)) throw new RangeError("Whole numbers only");
    if (threshold < 1 || parts < threshold || parts > 255) throw new RangeError("1 <= threshold <= parts <= 255");
    if (secret.length === 0) throw new RangeError("Nothing to split");
    // The package checks `constructor === Uint8Array`; a Buffer or a subclass is copied.
    const plain = Uint8Array.from(secret);
    try {
        if (threshold >= 2) return await audited.split(plain, parts, threshold);
        return distinctXs(parts).map((x) => {
            const share = new Uint8Array(plain.length + 1);
            share.set(plain);
            share[plain.length] = x;
            return share;
        });
    } finally {
        plain.fill(0);
    }
}

/**
 * The secret, from at least `threshold` shares of one split. Fewer combine to a
 * value unrelated to the secret, and nothing here can tell: whoever combines
 * checks the result (an account key against its published public keys).
 */
export async function combine(shares: ReadonlyArray<Uint8Array>): Promise<Uint8Array> {
    if (shares.length === 0) throw new RangeError("No shares");
    const length = shares[0]!.length;
    if (length < 2) throw new RangeError("A share holds at least one byte and its x");
    const xs = shares.map((share) => {
        if (share.length !== length) throw new RangeError("Shares of one split are the same length");
        if (share[length - 1] === 0) throw new RangeError("x = 0 is the secret itself, never a share");
        return share[length - 1]!;
    });
    if (new Set(xs).size !== xs.length) throw new RangeError("Two shares at the same x");
    if (shares.length === 1) return shares[0]!.slice(0, length - 1);
    return audited.combine(shares.map((share) => Uint8Array.from(share)));
}

function distinctXs(count: number): number[] {
    const taken = new Set<number>();
    while (taken.size < count) {
        for (const value of randomBytes(count * 2)) {
            if (value !== 0 && taken.size < count) taken.add(value);
        }
    }
    return [...taken];
}
