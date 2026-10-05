import { describe, expect, it } from "vitest";
import { displayWidth, textTable } from "./textTable.ts";

// The expected strings are what the `table` package printed for the same rows,
// which job-log parsers read the token table in.
describe("textTable", () => {
    it("draws the token table exactly as before", () => {
        expect(
            textTable([
                ["Input", "Cache Read", "Cache Write", "Output", "Total"],
                ["1,234", "0", "56", "789", "2,079"]
            ])
        ).toBe(
            [
                "╔═══════╤════════════╤═════════════╤════════╤═══════╗",
                "║ Input │ Cache Read │ Cache Write │ Output │ Total ║",
                "╟───────┼────────────┼─────────────┼────────┼───────╢",
                "║ 1,234 │ 0          │ 56          │ 789    │ 2,079 ║",
                "╚═══════╧════════════╧═════════════╧════════╧═══════╝",
                ""
            ].join("\n")
        );
    });

    it("draws a single cell", () => {
        expect(textTable([["a"]])).toBe("╔═══╗\n║ a ║\n╚═══╝\n");
    });

    it("measures wide characters as two columns", () => {
        expect(
            textTable([
                ["héllo", "日本"],
                ["x", "y"]
            ])
        ).toBe(
            "╔═══════╤══════╗\n║ héllo │ 日本 ║\n╟───────┼──────╢\n║ x     │ y    ║\n╚═══════╧══════╝\n"
        );
        expect(displayWidth("👍 ok")).toBe(5);
        expect(displayWidth(`e${String.fromCharCode(0x301)}`)).toBe(1);
    });

    it("spans a cell with a line break over several lines", () => {
        expect(
            textTable([
                ["two\nlines", "b"],
                ["c", ""]
            ])
        ).toBe(
            "╔═══════╤═══╗\n║ two   │ b ║\n║ lines │   ║\n╟───────┼───╢\n║ c     │   ║\n╚═══════╧═══╝\n"
        );
    });

    it("prints nothing for no rows", () => {
        expect(textTable([])).toBe("");
    });
});
