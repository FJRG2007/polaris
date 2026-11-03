// @vitest-environment jsdom
/**
 * A document's paragraphs come out whole and go back into their first run,
 * so the paragraph keeps its style and place; nothing else changes.
 */

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
    openDocument,
    translatedName,
    xmlSegments
} from "@polaris-app/translate/src/screens/documents";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hola </w:t></w:r><w:r><w:t>mundo</w:t></w:r></w:p><w:p><w:r><w:t> </w:t></w:r></w:p><w:p><w:r><w:t>Adiós</w:t></w:r></w:p></w:body></w:document>`;

describe("xmlSegments", () => {
    it("reads each paragraph whole and writes the translation into its first run", () => {
        const read = xmlSegments(DOCX, { paragraph: "w:p", text: "w:t" });
        expect(read.segments).toEqual(["Hola mundo", "Adiós"]);
        const out = read.apply(["Hello world", "Goodbye"]);
        expect(out.startsWith("<?xml")).toBe(true);
        expect(out).toContain("<w:b/>");
        expect(out).toContain(">Hello world</w:t>");
        expect(out).toContain(">Goodbye</w:t>");
        expect(out).not.toContain("mundo");
        expect(out).toContain('xml:space="preserve"');
    });

    it("leaves a spreadsheet's phonetic guide out of the text", () => {
        const xml =
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>東京</t><rPh><t>トウキョウ</t></rPh></si></sst>';
        expect(xmlSegments(xml, { paragraph: "si", text: "t", skip: "rPh" }).segments).toEqual([
            "東京"
        ]);
    });
});

describe("openDocument", () => {
    it("rebuilds a Word file with the translation in place", async () => {
        const zip = new JSZip();
        zip.file("[Content_Types].xml", "<Types/>");
        zip.file("word/document.xml", DOCX);
        const job = await openDocument(await zip.generateAsync({ type: "uint8array" }));
        expect(job.format).toBe("docx");
        expect(job.segments).toEqual(["Hola mundo", "Adiós"]);
        const blob = await job.build(["Hello world", "Goodbye"]);
        const back = await JSZip.loadAsync(await blob.arrayBuffer());
        const xml = await back.file("word/document.xml")!.async("string");
        expect(xml).toContain("Hello world");
        expect(back.file("[Content_Types].xml")).not.toBeNull();
    });

    it("refuses what is not a document, whatever it is called", async () => {
        await expect(openDocument(new Uint8Array([0x4d, 0x5a, 0, 0x90]))).rejects.toMatchObject({
            name: "DocumentError",
            code: "type"
        });
    });

    it("names the translation after the original and the language", () => {
        expect(translatedName("informe final.docx", "en", ".docx")).toBe("informe final.en.docx");
        expect(translatedName("a/b:c.pdf", "fr", ".txt")).toBe("a_b_c.fr.txt");
    });
});
