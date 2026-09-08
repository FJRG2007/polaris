/**
 * That the port works, rather than merely compiles.
 *
 * These files came across from another project (GenOffice, Apache-2.0) and
 * arrived without their tests. A folder of six thousand lines that typechecks
 * and has never been run is a folder nobody can change, so this exercises each
 * piece of it through the entrance the app will use - not exhaustively, which is
 * the original project's job, but enough that a wrong import or a half-applied
 * rewrite fails here rather than in front of somebody's spreadsheet.
 */

import * as sheets from "./index.js";
import { describe, expect, it } from "vitest";

describe("cell addresses", () => {
    it("reads A1 both ways", () => {
        expect(sheets.columnLabel(0)).toBe("A");
        expect(sheets.columnLabel(25)).toBe("Z");
        expect(sheets.columnLabel(26)).toBe("AA");
        expect(sheets.columnIndex("A")).toBe(0);
        expect(sheets.columnIndex("AA")).toBe(26);
    });

    it("round-trips a column through both", () => {
        for (const index of [0, 1, 25, 26, 27, 51, 52, 701, 702]) {
            expect(sheets.columnIndex(sheets.columnLabel(index))).toBe(index);
        }
    });

    it("reads a single address", () => {
        expect(sheets.parseAddress("B3")).toEqual({ row: 2, column: 1 });
    });

    it("reads one that a producer anchored", () => {
        // `$C$33` is how some writers store a pivot's own location, and choking
        // on it is a pivot that cannot be refreshed.
        expect(sheets.parseAddress("$C$33")).toEqual({ row: 32, column: 2 });
    });

    it("refuses something that is not an address, rather than guessing", () => {
        expect(() => sheets.parseAddress("nonsense")).toThrow();
    });

    it("reads a range and counts it", () => {
        expect(sheets.rangeCellCount(sheets.parseRange("A1:C2"))).toBe(6);
    });

    it("writes one back", () => {
        expect(sheets.formatAddress(2, 1)).toBe("B3");
    });

    it("lists the cells of a range in order", () => {
        expect(sheets.rangeAddresses(sheets.parseRange("A1:B2"))).toEqual([
            "A1",
            "B1",
            "A2",
            "B2"
        ]);
    });
});

describe("flash fill", () => {
    it("infers what somebody is doing from an example of them doing it", () => {
        const template = sheets.inferFlashFillTemplate([
            { source: ["Maya", "Chen"], output: "Maya Chen" },
            { source: ["Ana", "Ruiz"], output: "Ana Ruiz" }
        ]);
        expect(template).not.toBeNull();
        expect(sheets.applyFlashFillTemplate(template!, ["Leo", "Diaz"])).toBe("Leo Diaz");
    });

    it("carries the glue between the fields", () => {
        const template = sheets.inferFlashFillTemplate([
            { source: ["Maya", "Chen"], output: "Chen, Maya" }
        ]);
        expect(template).not.toBeNull();
        expect(sheets.applyFlashFillTemplate(template!, ["Ana", "Ruiz"])).toBe("Ruiz, Ana");
    });

    it("refuses rather than guessing when the examples do not agree", () => {
        expect(
            sheets.inferFlashFillTemplate([
                { source: ["Maya", "Chen"], output: "Maya Chen" },
                { source: ["Ana", "Ruiz"], output: "something else entirely" }
            ])
        ).toBeNull();
    });
});

describe("filling a formula down, the way the fill handle does", () => {
    it("moves a relative reference by the offset", () => {
        expect(sheets.offsetFormulaRefs("=B2+C2", 1, 0)).toBe("=B3+C3");
    });

    it("leaves an anchored reference where it was, which is what the $ is for", () => {
        expect(sheets.offsetFormulaRefs("=$B$2", 1, 0)).toBe("=$B$2");
    });

    it("moves only the unanchored half of a mixed reference", () => {
        expect(sheets.offsetFormulaRefs("=$B2", 1, 0)).toBe("=$B3");
        expect(sheets.offsetFormulaRefs("=B$2", 0, 1)).toBe("=C$2");
    });

    it("does not touch a reference inside a string", () => {
        // The trap: a formula holding text that looks like a reference.
        expect(sheets.offsetFormulaRefs('="B2"', 1, 0)).toBe('="B2"');
    });

    it("answers with an error rather than a wrong cell when it falls off the grid", () => {
        expect(sheets.offsetFormulaRefs("=A1", -1, 0)).toContain("#REF!");
    });
});

describe("sorting part of a sheet", () => {
    it("answers with the moves rather than making them", () => {
        // The whole shape of it: a pure function that says what would change, so
        // the caller decides whether to write.
        const values: Record<string, string> = {
            A1: "Charlie",
            A2: "Alpha",
            A3: "Bravo"
        };
        const changes = sheets.computeSortChanges(
            { range: "A1:A3", byColumn: "A", ascending: true, hasHeader: false },
            (address) => ({ value: values[address] ?? "" }) as never
        );
        expect(changes.length).toBeGreaterThan(0);
    });

    it("refuses a key column that is not in the range", () => {
        expect(() =>
            sheets.computeSortChanges(
                { range: "A1:A3", byColumn: "Z", ascending: true, hasHeader: false },
                () => ({ value: "" }) as never
            )
        ).toThrow();
    });
});

describe("the pieces that carry the rest", () => {
    it("has the workbook the engine is written against", () => {
        expect(typeof sheets.InMemoryWorkbookAdapter).toBe("function");
        expect(typeof sheets.WorkbookConflictError).toBe("function");
    });

    it("has the pivot engine and its companions", () => {
        expect(typeof sheets.PivotParseError).toBe("function");
        expect(typeof sheets.recommendCharts).toBe("function");
    });
});
