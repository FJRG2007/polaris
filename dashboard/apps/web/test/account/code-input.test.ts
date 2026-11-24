/**
 * What a code box keeps of what was typed or pasted.
 *
 * The box it replaced accepted a letter and lit its submit button on a single
 * character, so somebody pressed Confirm on "a" and was refused by the server.
 */

import { describe, expect, it } from "vitest";
import { codeDigits, exampleCode, isWholeCode, pasteInto, settleSelection, slotAt } from "../../src/components/code-input";

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

    it("shows an example that reads like a real code, as long as the code", () => {
        expect(exampleCode()).toMatch(/^\d{6}$/);
        expect(exampleCode()).not.toBe("000000");
        expect(exampleCode(4)).toHaveLength(4);
        expect(exampleCode(20)).toHaveLength(20);
    });
});

describe("where the caret of a code box goes", () => {
    it("selects a filled box, so a digit replaces it", () => {
        expect(settleSelection(2, 2, 6, 6)).toEqual([2, 3]);
        expect(settleSelection(0, 0, 3, 6)).toEqual([0, 1]);
    });

    it("leaves a bare caret on the first empty box, never past it", () => {
        expect(settleSelection(3, 3, 3, 6)).toEqual([3, 3]);
        expect(settleSelection(5, 5, 3, 6)).toEqual([3, 3]);
    });

    it("keeps the last box of a whole code, never a caret after it", () => {
        expect(settleSelection(6, 6, 6, 6)).toEqual([5, 6]);
    });

    it("leaves a deletion's caret bare, so the digit goes back in its place", () => {
        expect(settleSelection(3, 3, 5, 6, true)).toEqual([3, 3]);
        expect(settleSelection(3, 3, 6, 6, true)).toEqual([3, 4]);
    });

    it("keeps a selection of several boxes inside the code", () => {
        expect(settleSelection(0, 6, 6, 6)).toEqual([0, 6]);
        expect(settleSelection(1, 9, 4, 6)).toEqual([1, 4]);
    });
});

describe("a paste into a code box", () => {
    it("fills every box with a whole code, wherever the caret is", () => {
        expect(pasteInto("12", 1, 2, "987 654")).toEqual({ value: "987654", caret: 6 });
        expect(pasteInto("", 0, 0, "1234567")).toEqual({ value: "123456", caret: 6 });
    });

    it("writes a shorter one over the boxes from the caret", () => {
        expect(pasteInto("12345", 1, 2, "77")).toEqual({ value: "17745", caret: 3 });
        expect(pasteInto("12", 2, 2, "3-4")).toEqual({ value: "1234", caret: 4 });
    });

    it("replaces a selection of several boxes", () => {
        expect(pasteInto("123456", 0, 6, "12")).toEqual({ value: "12", caret: 2 });
    });

    it("does nothing without a digit", () => {
        expect(pasteInto("12", 2, 2, "abc")).toBeNull();
    });
});

describe("the box under a click", () => {
    const spans = [[0, 36], [40, 76], [80, 116]] as const;

    it("is the one it lands on, or the nearest", () => {
        expect(slotAt(50, spans)).toBe(1);
        expect(slotAt(38, spans)).toBe(0);
        expect(slotAt(-10, spans)).toBe(0);
        expect(slotAt(500, spans)).toBe(2);
    });
});
