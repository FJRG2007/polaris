/**
 * That the port is whole.
 *
 * Twenty-four files of geometry came across from GenOffice's three editors
 * (Apache-2.0) without their tests. What is asserted is that each half of the
 * package loads - an index that pulls in every module fails to evaluate if one
 * import does not resolve - and that a few of the functions actually answer,
 * chosen because they are the ones Polaris will call first.
 */

import { describe, expect, it } from "vitest";
import * as layout from "./index";

describe("what came across", () => {
    it("has the three editors' geometry", () => {
        expect(Object.keys(layout.doc).length).toBeGreaterThan(0);
        expect(Object.keys(layout.slides).length).toBeGreaterThan(0);
        expect(Object.keys(layout.pdf).length).toBeGreaterThan(0);
    });

    it("counts words the way a document does, in both kinds of script", () => {
        // Asian text counts by character and everything else by word, which is
        // the rule every word processor uses and the one nobody writes for
        // themselves correctly.
        expect(layout.doc.countWords("one two three")).toBe(3);
        expect(layout.doc.countWords("")).toBe(0);
        expect(layout.doc.asianCharCount("漢字")).toBe(2);
        expect(layout.doc.nonAsianWordCount("one two")).toBe(2);
    });

    it("reads a print range the way somebody types one", () => {
        // Zero-based, because what comes back indexes the pages rather than
        // naming them - which is the sort of thing worth pinning before
        // somebody wires it to a page number and is off by one.
        expect(layout.doc.parsePrintRange("1-3", 10)).toEqual([0, 1, 2]);
        expect(layout.doc.parsePrintRange("2,5", 10)).toEqual([1, 4]);
        // Past the end of the document, which is a typo rather than a page.
        expect(layout.doc.parsePrintRange("99", 10)).toBeNull();
    });

    it("numbers a footnote the way a document does", () => {
        // Lower case, which is what a footnote mark is.
        expect(layout.doc.toRoman(4)).toBe("iv");
        expect(layout.doc.toRoman(2026)).toBe("mmxxvi");
    });

    it("lays a slide's ruler out", () => {
        expect(typeof layout.slides.computeRulerTicks).toBe("function");
        expect(typeof layout.slides.formatRulerValue).toBe("function");
    });

    it("pages a PDF one sheet at a time or two", () => {
        expect(layout.pdf.spreadRows([0, 1, 2, 3], 1)).toEqual([[0], [1], [2], [3]]);
        expect(layout.pdf.spreadRows([0, 1, 2, 3], 2).length).toBeLessThan(4);
    });
});
