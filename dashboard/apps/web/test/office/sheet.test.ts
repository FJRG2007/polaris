/**
 * Two people typing in the same spreadsheet.
 *
 * The engine has no collaboration in it - that is the half its makers sell - so
 * this bridge is ours, and it is the part that decides whether two people
 * editing one workbook is a shared spreadsheet or a fight over it.
 *
 * Three failures are pinned, and each of them is somebody's work disappearing:
 * a cell somebody cleared coming back, a workbook being sent whole so the second
 * save erases the first, and the loop where two screens apply each other's cells
 * for ever because applying one looks exactly like typing one.
 */

import * as sheet from "@/lib/office/sheet";
import { describe, expect, it } from "vitest";

/** A workbook in the shape the engine stores one: sparse, keyed row then
 *  column. */
function workbook(cells: Record<string, Record<string, Record<string, unknown>>>) {
    return {
        sheets: Object.fromEntries(
            Object.entries(cells).map(([id, rows]) => [id, { cellData: rows }])
        )
    };
}

describe("finding the cells in a workbook", () => {
    it("flattens the sparse grid the engine keeps", () => {
        const found = sheet.cellsOf(workbook({ s1: { "0": { "0": { v: "A1" }, "2": { v: "C1" } } } }));
        expect([...found.keys()]).toEqual(["s1:0:0", "s1:0:2"]);
        expect(found.get("s1:0:0")).toEqual({ v: "A1" });
    });

    it("finds them across every sheet", () => {
        const found = sheet.cellsOf(
            workbook({ s1: { "0": { "0": { v: 1 } } }, s2: { "3": { "4": { v: 2 } } } })
        );
        expect([...found.keys()].sort()).toEqual(["s1:0:0", "s2:3:4"]);
    });

    it("has nothing to say about an empty workbook", () => {
        expect(sheet.cellsOf({}).size).toBe(0);
        expect(sheet.cellsOf(workbook({ s1: {} })).size).toBe(0);
    });
});

describe("where a cell is", () => {
    it("survives the trip out and back", () => {
        const key = sheet.sheetCellKey("sheet-abc", 12, 3);
        expect(sheet.readSheetCellKey(key)).toEqual({ sheetId: "sheet-abc", row: 12, column: 3 });
    });

    it("reads a sheet id that has a colon in it", () => {
        // Ids are generated, but the reader must not be the thing that decides
        // that: taking the LAST two segments is what makes it true either way.
        const key = sheet.sheetCellKey("a:b", 1, 2);
        expect(sheet.readSheetCellKey(key)).toEqual({ sheetId: "a:b", row: 1, column: 2 });
    });

    it("refuses anything that is not one rather than guessing", () => {
        expect(sheet.readSheetCellKey("nonsense")).toBeNull();
        expect(sheet.readSheetCellKey("s1:one:two")).toBeNull();
    });
});

describe("what to send", () => {
    it("is the cells that changed and nothing else", () => {
        const mine = new Map([
            ["s1:0:0", { v: 1 }],
            ["s1:0:1", { v: 2 }]
        ]);
        const theirs = new Map([
            ["s1:0:0", { v: 1 }],
            ["s1:0:1", { v: 99 }]
        ]);
        expect(sheet.changedCells(mine, theirs)).toEqual([{ key: "s1:0:1", cell: { v: 2 } }]);
    });

    it("is nothing when nothing moved", () => {
        // The engine reports a command for a selection and for a scroll. Writing
        // the sheet on those is a write per pointer move.
        const same = new Map([["s1:0:0", { v: 1, s: { bl: 1 } }]]);
        const copy = new Map([["s1:0:0", { v: 1, s: { bl: 1 } }]]);
        expect(sheet.changedCells(same, copy)).toEqual([]);
    });

    it("says so when a cell was emptied", () => {
        // The failure this prevents: somebody clears a number, nothing is sent
        // because there is no cell to send, and it comes back on every other
        // screen.
        const mine = new Map<string, sheet.SheetCell>();
        const theirs = new Map([["s1:0:0", { v: 1 }]]);
        expect(sheet.changedCells(mine, theirs)).toEqual([{ key: "s1:0:0", cell: null }]);
    });
});

describe("what to apply when somebody else's cells arrive", () => {
    it("is only what this workbook disagrees about", () => {
        // Writing a cell the workbook already agrees about makes the engine emit
        // a command, which is then read as a local change and sent back out.
        // Two screens doing that to each other never settle.
        const mine = new Map([["s1:0:0", { v: 1 }]]);
        const theirs = new Map([
            ["s1:0:0", { v: 1 }],
            ["s1:1:0", { v: 5 }]
        ]);
        expect(sheet.incomingCells(mine, theirs)).toEqual([{ key: "s1:1:0", cell: { v: 5 } }]);
    });

    it("clears a cell somebody else cleared", () => {
        const mine = new Map([["s1:0:0", { v: 1 }]]);
        expect(sheet.incomingCells(mine, new Map())).toEqual([{ key: "s1:0:0", cell: null }]);
    });

    it("is nothing at all when the two agree", () => {
        const mine = new Map([["s1:0:0", { v: 1 }]]);
        const theirs = new Map([["s1:0:0", { v: 1 }]]);
        expect(sheet.incomingCells(mine, theirs)).toEqual([]);
    });
});

describe("whether two cells say the same thing", () => {
    it("compares what they hold, not which object they are", () => {
        // The engine rebuilds these constantly; treating a fresh object as a
        // change would be a write on every render.
        expect(sheet.sameCell({ v: 1 }, { v: 1 })).toBe(true);
        expect(sheet.sameCell({ v: 1 }, { v: 2 })).toBe(false);
    });

    it("counts a style change as a change", () => {
        expect(sheet.sameCell({ v: 1 }, { v: 1, s: { bl: 1 } })).toBe(false);
    });

    it("does not call a missing cell equal to an empty one", () => {
        expect(sheet.sameCell(undefined, {})).toBe(false);
        expect(sheet.sameCell(undefined, undefined)).toBe(true);
    });
});
