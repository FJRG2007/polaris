import { describe, expect, it } from "vitest";
import {
    DEFAULT_ALPHABET,
    DEFAULT_LENGTH,
    formatGenerator,
    generateValue,
    isBrokenGenerator,
    parseGenerator
} from "@/lib/deploy/variable-generator";

describe("a variable generator", () => {
    it("reads the three ways Railway writes one", () => {
        expect(parseGenerator("${{ secret() }}")).toEqual({
            length: DEFAULT_LENGTH,
            alphabet: DEFAULT_ALPHABET
        });
        expect(parseGenerator("${{secret(32)}}")).toEqual({ length: 32, alphabet: DEFAULT_ALPHABET });
        expect(parseGenerator('  ${{ secret( 8 , "abc" ) }} ')).toEqual({
            length: 8,
            alphabet: "abc"
        });
    });

    it("is not a reference, a plain value or a value out of range", () => {
        expect(parseGenerator("${{postgres.DATABASE_URL}}")).toBeNull();
        expect(parseGenerator("secret(32)")).toBeNull();
        expect(parseGenerator("${{ secret(0) }}")).toBeNull();
        expect(parseGenerator("${{ secret(257) }}")).toBeNull();
        expect(parseGenerator('${{ secret(8, "a") }}')).toBeNull();
        expect(parseGenerator('${{ secret(8, "aab") }}')).toBeNull();
        expect(parseGenerator("${{ secret(8, abc) }}")).toBeNull();
        expect(isBrokenGenerator("${{ secret(0) }}")).toBe(true);
        expect(isBrokenGenerator("${{ secret(8) }}")).toBe(false);
        expect(isBrokenGenerator("plain")).toBe(false);
    });

    it("writes itself back the shortest way, reading as the same spec", () => {
        for (const spec of [
            { length: DEFAULT_LENGTH, alphabet: DEFAULT_ALPHABET },
            { length: 12, alphabet: DEFAULT_ALPHABET },
            { length: 6, alphabet: "0123456789" }
        ]) {
            expect(parseGenerator(formatGenerator(spec))).toEqual(spec);
        }
        expect(formatGenerator({ length: DEFAULT_LENGTH, alphabet: DEFAULT_ALPHABET })).toBe(
            "${{ secret() }}"
        );
    });

    it("draws the asked length from the asked characters", () => {
        const value = generateValue({ length: 64, alphabet: "xyz" });
        expect(value).toHaveLength(64);
        expect(value).toMatch(/^[xyz]+$/);
        expect(generateValue({ length: 32, alphabet: DEFAULT_ALPHABET })).not.toBe(
            generateValue({ length: 32, alphabet: DEFAULT_ALPHABET })
        );
    });

    it("throws away the bytes a modulo would fold onto the start of the alphabet", () => {
        // Three characters: 255 is the largest multiple of 3 a byte reaches, so
        // byte 255 must be skipped - with `% 3` it would have been "a" again.
        let calls = 0;
        const fill = (bytes: Uint8Array): Uint8Array => {
            calls += 1;
            bytes.fill(calls === 1 ? 255 : 4);
            return bytes;
        };
        expect(generateValue({ length: 4, alphabet: "abc" }, fill)).toBe("bbbb");
        expect(calls).toBe(2);
    });

    it("is close to uniform over many draws", () => {
        const counts = new Map<string, number>();
        const value = generateValue({ length: 30_000, alphabet: "abc" });
        for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
        for (const char of "abc") {
            expect(counts.get(char)).toBeGreaterThan(9_300);
            expect(counts.get(char)).toBeLessThan(10_700);
        }
    });
});
