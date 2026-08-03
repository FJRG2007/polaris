/**
 * Backup-code exports. The codes are shown once, so a file that turns out to be
 * unreadable is a lockout: the PDF is checked by actually parsing it back with
 * the same engine the drive viewer uses, not just by eyeballing its syntax.
 */

import { describe, expect, it } from "vitest";
import { backupCodesFile, backupCodesHtml } from "../../src/lib/backup-codes";

const CODES = ["B6GJZ-AfzDS", "gQy1M-ahWSm", "jBraT-pRqKr"];
const ACCOUNT = "Ada.Lovelace@example.com";
const ISSUED = new Date("2026-07-29T10:00:00.000Z");

describe("backup code files", () => {
    it("names each format after the account, and lists every code in it", () => {
        for (const format of ["txt", "json", "csv", "pdf"] as const) {
            const file = backupCodesFile(CODES, format, ACCOUNT, ISSUED);
            expect(file.name).toBe(`polaris-backup-codes-ada-lovelace-example-com.${format}`);
            for (const code of CODES) expect(file.body).toContain(code);
        }
    });

    it("keeps the plain name when there is no account to name it after", () => {
        expect(backupCodesFile(CODES, "txt", null, ISSUED).name).toBe("polaris-backup-codes.txt");
    });

    it("says which account the codes open, in the formats a person reads", () => {
        for (const format of ["txt", "pdf"] as const) {
            expect(backupCodesFile(CODES, format, ACCOUNT, ISSUED).body).toContain(ACCOUNT);
        }
    });

    it("writes JSON that parses back to the codes", () => {
        const parsed = JSON.parse(backupCodesFile(CODES, "json", ACCOUNT, ISSUED).body) as {
            account: string | null;
            issuedAt: string;
            codes: string[];
        };
        expect(parsed.codes).toEqual(CODES);
        expect(parsed.account).toBe(ACCOUNT);
        expect(parsed.issuedAt).toBe(ISSUED.toISOString());
    });

    it("writes a CSV with one header and one code per row", () => {
        expect(backupCodesFile(CODES, "csv", null, ISSUED).body.split("\n")).toEqual(["code", ...CODES]);
    });

    it("produces a PDF a reader can open and read the codes out of", async () => {
        const body = backupCodesFile(CODES, "pdf", null, ISSUED).body;
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
        const body = backupCodesFile(["a(b)c\\d"], "pdf", null, ISSUED).body;
        expect(body).toContain("(a\\(b\\)c\\\\d) Tj");
    });
});

describe("printable page", () => {
    it("lists every code", () => {
        const html = backupCodesHtml(CODES, null);
        for (const code of CODES) expect(html).toContain(`<li>${code}</li>`);
    });

    it("names the account, so a printed sheet says what it opens", () => {
        expect(backupCodesHtml(CODES, ACCOUNT)).toContain(ACCOUNT);
    });

    it("escapes an account that carries markup instead of printing it", () => {
        const html = backupCodesHtml(CODES, "<script>alert(1)</script>@example.com");
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });
});
