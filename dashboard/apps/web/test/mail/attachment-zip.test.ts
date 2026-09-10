/**
 * The names inside an archive of a message's files.
 *
 * Two rules, both about what happens when the archive is opened: a name from a
 * stranger's message must not be able to write outside the folder it is
 * extracted into, and two files with one name must both survive - an archive
 * with two identical entries keeps one of them when it is opened, silently.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mailbox/messages", () => ({
    readAttachment: async (_userId: string, id: string) => ({
        name: id,
        contentType: "application/octet-stream",
        bytes: Buffer.from(`bytes of ${id}`)
    })
}));

const { safeEntryName, uniqueEntryNames, attachmentZipSources } = await import(
    "@/lib/mailbox/attachment-zip"
);
const { createZipStream } = await import("@/lib/zip-stream");
const JSZip = (await import("jszip")).default;

describe("the archive itself", () => {
    it("opens in an ordinary extractor with every file and its bytes", async () => {
        const plan = {
            archiveName: "Invoices.zip",
            sentAt: new Date("2026-09-01T10:00:00Z"),
            files: [
                { id: "a1", entry: "scan.pdf", size: 12n },
                { id: "a2", entry: "scan (2).pdf", size: 12n }
            ]
        };
        const bytes = new Uint8Array(
            await new Response(createZipStream(attachmentZipSources("u1", plan))).arrayBuffer()
        );
        const zip = await JSZip.loadAsync(bytes);
        expect(Object.keys(zip.files).sort()).toEqual(["scan (2).pdf", "scan.pdf"]);
        expect(await zip.file("scan.pdf")!.async("string")).toBe("bytes of a1");
        expect(await zip.file("scan (2).pdf")!.async("string")).toBe("bytes of a2");
    });
});

describe("a name that is safe to extract", () => {
    it("cannot climb out of the folder or name a drive", () => {
        expect(safeEntryName("../../.bashrc")).toBe(".. .. .bashrc");
        expect(safeEntryName("C:\\Windows\\evil.dll")).toBe("C Windows evil.dll");
        expect(safeEntryName("/etc/passwd")).toBe("etc passwd");
        expect(safeEntryName("..")).toBe("attachment");
        expect(safeEntryName("")).toBe("attachment");
    });

    it("drops control characters and keeps an ordinary name as it was", () => {
        expect(safeEntryName("fac\u0000tura\n.pdf")).toBe("factura.pdf");
        expect(safeEntryName("Factura marzo.pdf")).toBe("Factura marzo.pdf");
    });
});

describe("names that collide", () => {
    it("numbers the second and third the way a file manager does", () => {
        expect(uniqueEntryNames(["scan.pdf", "scan.pdf", "Scan.PDF", "notes"])).toEqual([
            "scan.pdf",
            "scan (2).pdf",
            "Scan (3).PDF",
            "notes"
        ]);
    });
});
