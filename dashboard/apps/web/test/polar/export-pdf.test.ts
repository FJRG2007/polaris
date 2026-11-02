import { describe, expect, it } from "vitest";
import { pageTops, pdfOfJpegs } from "@/lib/polar/export-picture";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

describe("the PDF export", () => {
    it("is a file a PDF reader opens, with every page", async () => {
        const page = { jpeg: new Uint8Array([255, 216, 255, 217]), width: 2, height: 2, drawn: 100 };
        const blob = pdfOfJpegs([page, page, page]);
        const data = new Uint8Array(await blob.arrayBuffer());
        const document = await getDocument({ data, isEvalSupported: false }).promise;
        expect(document.numPages).toBe(3);
        const first = await document.getPage(1);
        expect(Math.round(first.view[3] ?? 0)).toBe(842);
    });
});

describe("where the PDF's pages start", () => {
    const lines = Array.from({ length: 10 }, (_, index) => ({
        top: index * 30 + 5,
        bottom: index * 30 + 25
    }));

    it("starts each page on a line, so none is cut through", () => {
        const tops = pageTops(lines, 305, 100);
        expect(tops).toEqual([0, 95, 185, 275]);
        for (const top of tops) {
            expect(lines.some((line) => line.top < top && line.bottom > top)).toBe(false);
        }
    });

    it("reads lines side by side as one, breaking only where both have ended", () => {
        const beside = [
            { top: 0, bottom: 20 },
            { top: 10, bottom: 95 },
            { top: 90, bottom: 110 },
            { top: 112, bottom: 130 }
        ];
        expect(pageTops(beside, 130, 120)).toEqual([0, 112]);
    });

    it("cuts where it falls when one stretch is taller than a page", () => {
        expect(pageTops([{ top: 0, bottom: 250 }], 250, 100)).toEqual([0, 100, 200]);
    });

    it("keeps a chat that fits on one page", () => {
        expect(pageTops(lines, 90, 100)).toEqual([0]);
    });
});
