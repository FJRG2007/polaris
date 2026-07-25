/**
 * Spreadsheet write-back. These cover the paths that decide what ends up in a
 * user's file: how typed text is stored, and the delimited and converted
 * exports. The .xlsx patch path runs xlsx-populate's browser bundle and is
 * covered in the browser instead.
 */

import { describe, expect, it } from "vitest";
import {
    cellValue,
    exportConvertedXlsx,
    exportDelimited,
    readWorkbook
} from "../../../src/app/(app)/drive/viewer/sheet-format";

function buffer(text: string): ArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("cellValue", () => {
    it("clears a blank cell", () => {
        expect(cellValue("")).toBeNull();
        expect(cellValue("   ")).toBeNull();
    });

    it("stores a number when the text is exactly how it prints", () => {
        expect(cellValue("42")).toBe(42);
        expect(cellValue("12.5")).toBe(12.5);
        expect(cellValue(" -3 ")).toBe(-3);
    });

    it("keeps text that a number would alter", () => {
        expect(cellValue("007")).toBe("007");
        expect(cellValue("1,5")).toBe("1,5");
        expect(cellValue("1.50")).toBe("1.50");
        expect(cellValue("+34 600 000 000")).toBe("+34 600 000 000");
    });
});

describe("readWorkbook", () => {
    it("reads a sheet into a grid with room to append", async () => {
        const { grids } = await readWorkbook(buffer("name,qty\nbolt,4\n"));
        const grid = grids[0]!;
        expect(grid.rows[0]).toEqual(["name", "qty", "", ""]);
        expect(grid.rows[1]).toEqual(["bolt", "4", "", ""]);
        // Two blank rows of content plus the appended blank ones.
        expect(grid.rows.length).toBe(10);
        expect(grid.columns).toBe(4);
    });
});

describe("exportDelimited", () => {
    it("applies edits and appended rows without trailing blanks", async () => {
        const { workbook } = await readWorkbook(buffer("name,qty\nbolt,4\nnut,7\n"));
        const sheet = workbook.SheetNames[0]!;
        const blob = await exportDelimited(
            workbook,
            [
                { sheet, row: 1, column: 1, value: "9" },
                { sheet, row: 3, column: 0, value: "washer" },
                { sheet, row: 3, column: 1, value: "007" }
            ],
            sheet,
            "csv"
        );
        expect((await blob.text()).trim()).toBe("name,qty\nbolt,9\nnut,7\nwasher,007");
    });

    it("clearing a cell does not grow the sheet", async () => {
        const { workbook } = await readWorkbook(buffer("a,b\n1,2\n"));
        const sheet = workbook.SheetNames[0]!;
        const blob = await exportDelimited(
            workbook,
            [
                { sheet, row: 1, column: 1, value: "" },
                { sheet, row: 40, column: 5, value: "  " }
            ],
            sheet,
            "csv"
        );
        expect((await blob.text()).trim()).toBe("a,b\n1,");
    });

    it("writes tabs for a .tsv", async () => {
        const { workbook } = await readWorkbook(buffer("a,b\n1,2\n"));
        const sheet = workbook.SheetNames[0]!;
        const blob = await exportDelimited(workbook, [], sheet, "tsv");
        expect((await blob.text()).trim()).toBe("a\tb\n1\t2");
    });
});

describe("exportConvertedXlsx", () => {
    it("carries the edits into the converted copy", async () => {
        const XLSX = await import("xlsx");
        const source = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            source,
            XLSX.utils.aoa_to_sheet([
                ["item", "qty"],
                ["bolt", 4]
            ]),
            "Legacy"
        );
        const legacy = XLSX.write(source, { bookType: "xls", type: "array" }) as ArrayBuffer;

        const { workbook } = await readWorkbook(legacy);
        const blob = await exportConvertedXlsx(workbook, [
            { sheet: "Legacy", row: 1, column: 0, value: "washer" },
            { sheet: "Legacy", row: 1, column: 1, value: "12" }
        ]);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        const reread = XLSX.read(bytes, { type: "array" });
        const sheet = reread.Sheets["Legacy"]!;
        expect(sheet["A2"]?.v).toBe("washer");
        expect(sheet["B2"]?.v).toBe(12);
        expect(sheet["B2"]?.t).toBe("n");
    });
});
