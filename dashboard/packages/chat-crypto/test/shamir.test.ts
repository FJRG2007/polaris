/**
 * Shamir secret sharing over GF(2^8): any M of N shares give the secret back,
 * fewer give nothing that depends on it, and malformed share sets are refused
 * instead of combining to a wrong secret silently.
 */

import * as shamir from "../src/shamir";
import { describe, expect, it } from "vitest";

const SECRET = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);

function subsets<T>(items: readonly T[], size: number): T[][] {
    if (size === 0) return [[]];
    if (items.length < size) return [];
    const [head, ...rest] = items;
    return [...subsets(rest, size - 1).map((subset) => [head!, ...subset]), ...subsets(rest, size)];
}

describe("GF(2^8) arithmetic", () => {
    it("multiplies as the AES field does", () => {
        // FIPS 197 section 4.2: {57} x {83} = {c1}, {57} x {13} = {fe}.
        expect(shamir.gfMul(0x57, 0x83)).toBe(0xc1);
        expect(shamir.gfMul(0x57, 0x13)).toBe(0xfe);
        expect(shamir.gfMul(0, 0x57)).toBe(0);
        expect(shamir.gfMul(1, 0x57)).toBe(0x57);
    });

    it("inverts every non-zero element", () => {
        for (let value = 1; value < 256; value++) expect(shamir.gfMul(value, shamir.gfInv(value))).toBe(1);
    });
});

describe("split and combine", () => {
    it("gives the secret back from every subset of the threshold, 2 of 3", () => {
        const shares = shamir.split(SECRET, 3, 2);
        expect(shares).toHaveLength(3);
        for (const subset of subsets(shares, 2)) expect(shamir.combine(subset)).toEqual(SECRET);
        expect(shamir.combine(shares)).toEqual(SECRET);
    });

    it("gives the secret back from every subset of the threshold, 3 of 5", () => {
        const shares = shamir.split(SECRET, 5, 3);
        for (const subset of subsets(shares, 3)) expect(shamir.combine(subset)).toEqual(SECRET);
    });

    it("1 of 1 is the secret itself behind its x coordinate", () => {
        const [share] = shamir.split(SECRET, 1, 1);
        expect(share!.subarray(1)).toEqual(SECRET);
        expect(shamir.combine([share!])).toEqual(SECRET);
    });

    it("below the threshold the result is not the secret", () => {
        const shares = shamir.split(SECRET, 3, 2);
        // One share of a 2-of-3 split is a lone point: "combining" it reads its y,
        // which is the secret plus a random line, never the secret.
        for (const share of shares) expect(shamir.combine([share])).not.toEqual(SECRET);
    });

    it("draws distinct, non-zero x coordinates and fresh randomness every split", () => {
        const first = shamir.split(SECRET, 5, 3);
        const xs = new Set(first.map((share) => share[0]));
        expect(xs.size).toBe(5);
        expect(xs.has(0)).toBe(false);
        const second = shamir.split(SECRET, 5, 3);
        expect(second.map((share) => Array.from(share))).not.toEqual(first.map((share) => Array.from(share)));
    });

    it("a single share is uniform: one byte position takes every value across splits", () => {
        const seen = new Set<number>();
        for (let round = 0; round < 2000 && seen.size < 256; round++) seen.add(shamir.split(SECRET, 2, 2)[0]![1]!);
        expect(seen.size).toBe(256);
    });

    it("refuses bad parameters", () => {
        expect(() => shamir.split(SECRET, 2, 3)).toThrow(RangeError);
        expect(() => shamir.split(SECRET, 0, 0)).toThrow(RangeError);
        expect(() => shamir.split(SECRET, 256, 2)).toThrow(RangeError);
        expect(() => shamir.split(new Uint8Array(0), 3, 2)).toThrow(RangeError);
    });

    it("refuses share sets that cannot be combined", () => {
        const shares = shamir.split(SECRET, 3, 2);
        expect(() => shamir.combine([])).toThrow(RangeError);
        expect(() => shamir.combine([shares[0]!, shares[0]!])).toThrow(RangeError);
        expect(() => shamir.combine([shares[0]!, shares[1]!.subarray(0, 10)])).toThrow(RangeError);
        const zero = Uint8Array.from(shares[1]!);
        zero[0] = 0;
        expect(() => shamir.combine([shares[0]!, zero])).toThrow(RangeError);
    });
});
