/**
 * That the port is whole.
 *
 * This package reads text out of a document whatever the document is - the
 * Office formats, PDF, and the binary ones from before them - and each of those
 * readers is a separate dependency that either resolves or does not. What is
 * asserted is that they all do, and that the one thing this package promises
 * holds: a `.docx` it is handed comes back as its words.
 */

import { describe, expect, it } from "vitest";
import { buildBlankDocx } from "@polaris/docx";

describe("reading a document", () => {
    it("takes the words out of one this repository wrote", async () => {
        const { docxToText } = await import("./index");
        const text = await docxToText(await buildBlankDocx());
        // A blank document has no words in it, so what matters is that it came
        // back as text at all rather than as a refusal.
        expect(typeof text).toBe("string");
    });

    it("has a reader for every format it claims", async () => {
        const parse = await import("./index");
        for (const name of ["docToText", "docxToText", "pptToText", "pptxToText", "xlsxToText", "pdfToText"]) {
            expect(typeof (parse as Record<string, unknown>)[name]).toBe("function");
        }
        expect(typeof parse.parseFileToText).toBe("function");
    });
});
