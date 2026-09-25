/**
 * What a code box keeps of what was typed or pasted.
 *
 * The box it replaced accepted a letter and lit its submit button on a single
 * character, so somebody pressed Confirm on "a" and was refused by the server.
 */

import { describe, expect, it } from "vitest";
import { codeDigits, isWholeCode } from "../../src/components/code-input";

describe("a code box", () => {
    it("keeps only the digits", () => {
        expect(codeDigits("a")).toBe("");
        expect(codeDigits("12a4")).toBe("124");
    });

    it("takes a code pasted with a space or a dash in it", () => {
        expect(codeDigits("123 456")).toBe("123456");
        expect(codeDigits("123-456")).toBe("123456");
    });

    it("holds at most a code's worth", () => {
        expect(codeDigits("1234567")).toBe("123456");
    });

    it("is ready only with six digits", () => {
        expect(isWholeCode("")).toBe(false);
        expect(isWholeCode("12345")).toBe(false);
        expect(isWholeCode("123456")).toBe(true);
    });
});
