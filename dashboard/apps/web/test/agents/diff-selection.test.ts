import { describe, expect, it } from "vitest";
import {
    SELECTION_MAX_LINES,
    parseUnifiedDiff,
    selectionOf,
    selectionPrompt,
    selectionRange
} from "@/lib/agents/session-review-loop";

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " export { a };"
].join("\n");

describe("selectionOf", () => {
    const lines = parseUnifiedDiff(DIFF);

    it("reads the range on the new side, in either order, headers skipped", () => {
        const selection = selectionOf("src/a.ts", lines, 6, 0);
        expect(selection).toMatchObject({ path: "src/a.ts", side: "new", start: 10, end: 13 });
        expect(selection?.code).toEqual([" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export { a };"]);
    });

    it("falls to the old side when only removed lines are picked", () => {
        expect(selectionOf("src/a.ts", lines, 3, 3)).toMatchObject({ side: "old", start: 11, end: 11 });
    });

    it("is nothing when only headers are picked", () => {
        expect(selectionOf("src/a.ts", lines, 0, 1)).toBeNull();
    });

    it("carries at most the line ceiling", () => {
        const long = parseUnifiedDiff(["@@ -1,0 +1,300 @@", ...Array.from({ length: 300 }, (_, i) => `+line ${i}`)].join("\n"));
        expect(selectionOf("x", long, 0, 300)?.code).toHaveLength(SELECTION_MAX_LINES);
    });
});

describe("selectionPrompt", () => {
    it("names the range and quotes the lines as a diff, then the note", () => {
        const selection = selectionOf("src/a.ts", parseUnifiedDiff(DIFF), 4, 5)!;
        expect(selectionRange(selection)).toBe("L11-L12");
        const text = selectionPrompt(selection, "  Use a constant.  ", "About src/a.ts (L11-L12):");
        expect(text).toBe(
            ["About src/a.ts (L11-L12):", "", "```diff", "+const b = 3;", "+const c = 4;", "```", "", "Use a constant."].join("\n")
        );
    });

    it("leaves the note out when there is none, and keeps a fence the code cannot close", () => {
        const text = selectionPrompt({ path: "a.md", side: "new", start: 1, end: 1, code: ["+```js"] }, "", "H");
        expect(text).toBe(["H", "", "~~~~diff", "+```js", "~~~~"].join("\n"));
        expect(selectionRange({ start: 4, end: 4 })).toBe("L4");
    });
});
