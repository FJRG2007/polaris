/**
 * Backup-code exports. The codes are shown once, so a file that turns out to be
 * unreadable is a lockout: the PDF is checked by actually parsing it back with
 * the same engine the drive viewer uses, not just by eyeballing its syntax.
 */

import { describe, expect, it } from "vitest";
import { backupCodesFile, backupCodesHtml } from "../../src/lib/backup-codes";

const CODES = ["B6GJZ-AfzDS", "gQy1M-ahWSm", "jBraT-pRqKr"];
const ISSUED = new Date("2026-07-29T10:00:00.000Z");

describe("backup code files", () => {
    it("names each format and lists every code in it", () => {
        for (const format of ["txt", "json", "csv", "pdf"] as const) {
            const file = backupCodesFile(CODES, format, ISSUED);
            expect(file.name).toBe(`polaris-backup-codes.${format}`);
            for (const code of CODES) expect(file.body).toContain(code);
        }
    });

    it("writes JSON that parses back to the codes", () => {
        const parsed = JSON.parse(backupCodesFile(CODES, "json", ISSUED).body) as {
            issuedAt: string;
            codes: string[];
        };
        expect(parsed.codes).toEqual(CODES);
        expect(parsed.issuedAt).toBe(ISSUED.toISOString());
    });

    it("writes a CSV with one header and one code per row", () => {
        expect(backupCodesFile(CODES, "csv", ISSUED).body.split("\n")).toEqual(["code", ...CODES]);
    });

    it("produces a PDF a reader can open and read the codes out of", async () => {
        const body = backupCodesFile(CODES, "pdf", ISSUED).body;
        expect(body.startsWith("%PDF-1.4")).toBe(true);
        expect(body.trimEnd().endsWith("%%EOF")).toBe(true);

        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const document = await pdfjs.getDocument({
            data: Uint8Array.from(body, (character) => character.charCodeAt(0)),
            useSystemFonts: true
        }).promise;
        expect(document.numPages).toBe(1);
        const content = await (await document.getPage(1)).getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        for (const code of CODES) expect(text).toContain(code);
    });

    it("escapes PDF string syntax instead of breaking the file", () => {
        const body = backupCodesFile(["a(b)c\\d"], "pdf", ISSUED).body;
        expect(body).toContain("(a\\(b\\)c\\\\d) Tj");
    });
});

describe("printable page", () => {
    it("lists every code", () => {
        const html = backupCodesHtml(CODES);
        for (const code of CODES) expect(html).toContain(`<li>${code}</li>`);
    });
});
