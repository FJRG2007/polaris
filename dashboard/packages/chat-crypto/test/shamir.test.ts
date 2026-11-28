/**
 * Shamir secret sharing over GF(2^8), on the vendored audited package: any M of
 * N shares give the secret back, fewer give nothing that depends on it, and
 * malformed share sets are refused instead of combining to a wrong secret
 * silently. The package's field is checked against an independent reference
 * multiplication that is itself checked against FIPS 197.
 */

import * as shamir from "../src/shamir";
import { describe, expect, it } from "vitest";

const SECRET = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);

/** Reference GF(2^8) multiply mod 0x11b, shift-and-add, written for this test only. */
function gfMul(a: number, b: number): number {
    let product = 0;
    let x = a;
    let y = b;
    while (y > 0) {
        if (y & 1) product ^= x;
        x = x & 0x80 ? ((x << 1) ^ 0x11b) & 0xff : x << 1;
        y >>= 1;
    }
    return product;
}

function gfInv(a: number): number {
    for (let candidate = 1; candidate < 256; candidate++) if (gfMul(a, candidate) === 1) return candidate;
    throw new RangeError("0 has no inverse");
}

/** Lagrange at 0 with the reference field, over shares laid out y || x. */
function referenceCombine(shares: Uint8Array[]): Uint8Array {
    const length = shares[0]!.length;
    const xs = shares.map((share) => share[length - 1]!);
    const secret = new Uint8Array(length - 1);
    for (let position = 0; position < secret.length; position++) {
        let value = 0;
        xs.forEach((xi, i) => {
            let basis = 1;
            xs.forEach((xj, j) => {
                if (i !== j) basis = gfMul(basis, gfMul(xj, gfInv(xj ^ xi)));
            });
            value ^= gfMul(shares[i]![position]!, basis);
        });
        secret[position] = value;
    }
    return secret;
}

function subsets<T>(items: readonly T[], size: number): T[][] {
    if (size === 0) return [[]];
    if (items.length < size) return [];
    const [head, ...rest] = items;
    return [...subsets(rest, size - 1).map((subset) => [head!, ...subset]), ...subsets(rest, size)];
}

const xOf = (share: Uint8Array) => share[share.length - 1]!;

describe("GF(2^8) field", () => {
    it("the reference multiplies as FIPS 197 does", () => {
        // FIPS 197 section 4.2: {57} x {83} = {c1}, {57} x {13} = {fe}.
        expect(gfMul(0x57, 0x83)).toBe(0xc1);
        expect(gfMul(0x57, 0x13)).toBe(0xfe);
        expect(gfMul(0, 0x57)).toBe(0);
        expect(gfMul(1, 0x57)).toBe(0x57);
        for (let value = 1; value < 256; value++) expect(gfMul(value, gfInv(value))).toBe(1);
    });

    it("the package splits in that same field", async () => {
        for (const [parts, threshold] of [
            [3, 2],
            [5, 3],
            [4, 4]
        ] as const) {
            const shares = await shamir.split(SECRET, parts, threshold);
            for (const subset of subsets(shares, threshold)) expect(referenceCombine(subset)).toEqual(SECRET);
        }
    });

    it("the package combines in that same field", async () => {
        // A degree-2 polynomial per byte, built with the reference field.
        const xs = [0x01, 0x53, 0xca, 0xff];
        const shares = xs.map((x) => {
            const share = new Uint8Array(SECRET.length + 1);
            share[SECRET.length] = x;
            SECRET.forEach((byte, position) => {
                const a1 = (position * 13 + 7) & 0xff;
                const a2 = (position * 29 + 3) & 0xff;
                share[position] = byte ^ gfMul(a1, x) ^ gfMul(a2, gfMul(x, x));
            });
            return share;
        });
        for (const subset of subsets(shares, 3)) expect(await shamir.combine(subset)).toEqual(SECRET);
    });
});

describe("split and combine", () => {
    it("gives the secret back from every subset of the threshold, 2 of 3", async () => {
        const shares = await shamir.split(SECRET, 3, 2);
        expect(shares).toHaveLength(3);
        for (const subset of subsets(shares, 2)) expect(await shamir.combine(subset)).toEqual(SECRET);
        expect(await shamir.combine(shares)).toEqual(SECRET);
    });

    it("gives the secret back from every subset of the threshold, 3 of 5", async () => {
        const shares = await shamir.split(SECRET, 5, 3);
        for (const subset of subsets(shares, 3)) expect(await shamir.combine(subset)).toEqual(SECRET);
    });

    it("1 of 1 is the secret itself before its x coordinate", async () => {
        const [share] = await shamir.split(SECRET, 1, 1);
        expect(share!.subarray(0, SECRET.length)).toEqual(SECRET);
        expect(xOf(share!)).not.toBe(0);
        expect(await shamir.combine([share!])).toEqual(SECRET);
    });

    it("1 of 2 gives the secret from either share and from both", async () => {
        const shares = await shamir.split(SECRET, 2, 1);
        for (const share of shares) expect(await shamir.combine([share])).toEqual(SECRET);
        expect(await shamir.combine(shares)).toEqual(SECRET);
    });

    it("below the threshold the result is not the secret", async () => {
        const shares = await shamir.split(SECRET, 3, 2);
        for (const share of shares) expect(await shamir.combine([share])).not.toEqual(SECRET);
        const three = await shamir.split(SECRET, 5, 3);
        for (const subset of subsets(three, 2)) expect(await shamir.combine(subset)).not.toEqual(SECRET);
    });

    it("draws distinct, non-zero x coordinates and fresh randomness every split", async () => {
        const first = await shamir.split(SECRET, 5, 3);
        const xs = new Set(first.map(xOf));
        expect(xs.size).toBe(5);
        expect(xs.has(0)).toBe(false);
        const second = await shamir.split(SECRET, 5, 3);
        expect(second.map((share) => Array.from(share))).not.toEqual(first.map((share) => Array.from(share)));
    });

    it("a single share is uniform: one byte position takes every value across splits", async () => {
        const seen = new Set<number>();
        for (let round = 0; round < 8000 && seen.size < 256; round++) seen.add((await shamir.split(SECRET, 2, 2))[0]![0]!);
        expect(seen.size).toBe(256);
    });

    it("never changes the caller's secret and accepts a subclass of Uint8Array", async () => {
        class Bytes extends Uint8Array {}
        const secret = Bytes.from(SECRET);
        const shares = await shamir.split(secret, 3, 2);
        expect(Array.from(secret)).toEqual(Array.from(SECRET));
        expect(await shamir.combine(shares.slice(1))).toEqual(SECRET);
    });

    it("refuses bad parameters", async () => {
        await expect(shamir.split(SECRET, 2, 3)).rejects.toThrow();
        await expect(shamir.split(SECRET, 0, 0)).rejects.toThrow(RangeError);
        await expect(shamir.split(SECRET, 256, 2)).rejects.toThrow(RangeError);
        await expect(shamir.split(new Uint8Array(0), 3, 2)).rejects.toThrow(RangeError);
        await expect(shamir.split(SECRET, 2.5, 2)).rejects.toThrow(RangeError);
    });

    it("refuses share sets that cannot be combined", async () => {
        const shares = await shamir.split(SECRET, 3, 2);
        await expect(shamir.combine([])).rejects.toThrow(RangeError);
        await expect(shamir.combine([shares[0]!, shares[0]!])).rejects.toThrow(RangeError);
        await expect(shamir.combine([shares[0]!, shares[1]!.subarray(0, 10)])).rejects.toThrow(RangeError);
        const zero = Uint8Array.from(shares[1]!);
        zero[zero.length - 1] = 0;
        await expect(shamir.combine([shares[0]!, zero])).rejects.toThrow(RangeError);
    });
});
