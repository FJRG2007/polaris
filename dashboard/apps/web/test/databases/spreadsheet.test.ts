/**
 * Rows copied out of somebody's database and pasted into a spreadsheet. The
 * cells are data that anybody with write access to that table chose, so none of
 * them may arrive as a formula, or reshape the grid it lands in.
 */

import { describe, expect, it } from "vitest";
import { spreadsheetSafe } from "@/lib/data/spreadsheet";

describe("spreadsheetSafe", () => {
    it("turns anything that starts like a formula into text", () => {
        expect(spreadsheetSafe('=HYPERLINK("https://example.test","x")')).toBe(
            `'=HYPERLINK("https://example.test","x")`
        );
        expect(spreadsheetSafe("+1+1")).toBe("'+1+1");
        expect(spreadsheetSafe("-2+3")).toBe("'-2+3");
        expect(spreadsheetSafe("@SUM(A1)")).toBe("'@SUM(A1)");
    });

    it("keeps one value in one cell", () => {
        expect(spreadsheetSafe("a\tb\r\nc")).toBe("a b c");
        expect(spreadsheetSafe("x\n=1+1")).toBe("x =1+1");
    });

    it("leaves ordinary values alone", () => {
        expect(spreadsheetSafe("alice@example.test")).toBe("alice@example.test");
        expect(spreadsheetSafe("42")).toBe("42");
    });
});
