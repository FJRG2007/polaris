/**
 * The file type a listing shows at a glance. What matters here is that the types
 * people actually scan for - a presentation, a spreadsheet, a pdf, an archive -
 * never collapse into the same generic mark, and that an unknown extension still
 * gets a sane icon instead of nothing.
 */

import { describe, expect, it } from "vitest";
import { fileIconFor } from "../../src/app/(app)/drive/file-icons";

describe("fileIconFor", () => {
    it("gives each office format its own mark", () => {
        const presentation = fileIconFor("Q3 deck.pptx");
        const spreadsheet = fileIconFor("budget.xlsx");
        const document = fileIconFor("contract.docx");
        const pdf = fileIconFor("invoice.pdf");
        const marks = [presentation, spreadsheet, document, pdf].map((mark) => mark.icon);
        expect(new Set(marks).size).toBe(4);
    });

    it("marks every archive format the same way", () => {
        const zip = fileIconFor("photos.zip");
        for (const name of ["backup.rar", "logs.tar", "dump.gz", "old.7z", "data.zst"]) {
            expect(fileIconFor(name).icon).toBe(zip.icon);
        }
    });

    it("groups media by kind", () => {
        expect(fileIconFor("clip.mp4").icon).toBe(fileIconFor("movie.mkv").icon);
        expect(fileIconFor("song.mp3").icon).toBe(fileIconFor("take.flac").icon);
        expect(fileIconFor("shot.png").icon).toBe(fileIconFor("scan.heic").icon);
        expect(fileIconFor("clip.mp4").icon).not.toBe(fileIconFor("song.mp3").icon);
    });

    it("ignores the case of the extension", () => {
        expect(fileIconFor("REPORT.PDF")).toEqual(fileIconFor("report.pdf"));
    });

    it("falls back to a plain file for anything unknown", () => {
        const unknown = fileIconFor("machine.bin");
        expect(unknown.icon).toBe(fileIconFor("no-extension").icon);
        expect(unknown.className).toBeTruthy();
    });

    it("keeps colors as literal classes so the CSS build keeps them", () => {
        for (const name of ["a.pptx", "b.xlsx", "c.pdf", "d.zip", "e.ts"]) {
            expect(fileIconFor(name).className).not.toContain("${");
        }
    });
});
