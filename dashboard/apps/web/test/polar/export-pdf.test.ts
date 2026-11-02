import { describe, expect, it } from "vitest";
import { pdfOfJpegs } from "@/lib/polar/export-picture";
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
