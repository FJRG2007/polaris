/**
 * Shamir secret sharing over GF(2^8), byte by byte (the construction of
 * privy-io/shamir-secret-sharing and HashiCorp Vault's `shamir` package: the
 * AES field, polynomial x^8 + x^4 + x^3 + x + 1, one random polynomial of degree
 * threshold - 1 per secret byte, a distinct random non-zero x per share).
 *
 *     share = x(1) || y(secret.length)
 *
 * Neither library is a dependency of this package and none is vendored: this
 * track could not add one (no install), and the repo's Rust core has no secret
 * sharing crate. So the arithmetic is written here, branch-free and without
 * lookup tables - multiplication is shift-and-add with masks and the inverse is
 * a^254 - so no timing or cache line depends on a secret byte, which the table
 * versions of both references do not promise. The tests check the field against
 * FIPS 197 and every subset of a split. Swapping in the audited package later
 * changes nothing stored: the share layout is the same.
 */

import { randomBytes } from "./bytes";

/** Multiply in GF(2^8) mod 0x11b, constant time. */
export function gfMul(a: number, b: number): number {
    let product = 0;
    let x = a & 0xff;
    let y = b & 0xff;
    for (let bit = 0; bit < 8; bit++) {
        product ^= x & -(y & 1);
        const carry = -((x >> 7) & 1);
        x = ((x << 1) ^ (0x1b & carry)) & 0xff;
        y >>= 1;
    }
    return product & 0xff;
}

/** The multiplicative inverse, a^254 (0 maps to 0, never asked for here). */
export function gfInv(a: number): number {
    let result = 1;
    let base = a & 0xff;
    let exponent = 254;
    for (let bit = 0; bit < 8; bit++) {
        const factor = gfMul(result, base);
        const mask = -(exponent & 1);
        result = (factor & mask) | (result & ~mask);
        base = gfMul(base, base);
        exponent >>= 1;
    }
    return result & 0xff;
}

/** `parts` shares, any `threshold` of which give `secret` back. */
export function split(secret: Uint8Array, parts: number, threshold: number): Uint8Array[] {
    if (!Number.isInteger(parts) || !Number.isInteger(threshold)) throw new RangeError("Whole numbers only");
    if (threshold < 1 || parts < threshold || parts > 255) throw new RangeError("1 <= threshold <= parts <= 255");
    if (secret.length === 0) throw new RangeError("Nothing to split");

    const xs = distinctXs(parts);
    const shares = xs.map((x) => {
        const share = new Uint8Array(1 + secret.length);
        share[0] = x;
        return share;
    });
    const coefficients = new Uint8Array(threshold);
    for (let position = 0; position < secret.length; position++) {
        coefficients[0] = secret[position]!;
        coefficients.set(randomBytes(threshold - 1), 1);
        shares.forEach((share, index) => {
            // Horner's rule from the highest coefficient down.
            let y = 0;
            for (let degree = threshold - 1; degree >= 0; degree--) y = gfMul(y, xs[index]!) ^ coefficients[degree]!;
            share[1 + position] = y;
        });
    }
    coefficients.fill(0);
    return shares;
}

/**
 * The secret, from at least `threshold` shares of one split. Fewer combine to a
 * value unrelated to the secret, and nothing here can tell: whoever combines
 * checks the result (an account key against its published public keys).
 */
export function combine(shares: ReadonlyArray<Uint8Array>): Uint8Array {
    if (shares.length === 0) throw new RangeError("No shares");
    const length = shares[0]!.length;
    if (length < 2) throw new RangeError("A share holds an x and at least one byte");
    const xs = shares.map((share) => {
        if (share.length !== length) throw new RangeError("Shares of one split are the same length");
        if (share[0] === 0) throw new RangeError("x = 0 is the secret itself, never a share");
        return share[0]!;
    });
    if (new Set(xs).size !== xs.length) throw new RangeError("Two shares at the same x");

    // Lagrange basis at 0: l_i = prod_{j != i} x_j / (x_j - x_i); minus is xor.
    const basis = xs.map((xi, i) => {
        let numerator = 1;
        let denominator = 1;
        xs.forEach((xj, j) => {
            if (i === j) return;
            numerator = gfMul(numerator, xj);
            denominator = gfMul(denominator, xj ^ xi);
        });
        return gfMul(numerator, gfInv(denominator));
    });
    const secret = new Uint8Array(length - 1);
    for (let position = 0; position < secret.length; position++) {
        let value = 0;
        shares.forEach((share, index) => {
            value ^= gfMul(share[1 + position]!, basis[index]!);
        });
        secret[position] = value;
    }
    return secret;
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
