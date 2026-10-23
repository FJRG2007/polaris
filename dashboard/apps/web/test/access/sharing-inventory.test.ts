/**
 * The sharing inventory is the list a new screen is checked against, so it has
 * to stay true to the code: every subject it names is one a grant can be about,
 * and every subject a grant can be about is in it - a new one added without a
 * row is the next "I cannot share this" nobody wrote down.
 */

import { join } from "node:path";
import * as core from "@polaris/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const doc = readFileSync(join(process.cwd(), "../../../docs/sharing-inventory.md"), "utf8");

/** The table's rows, as their cells. The header and the divider are skipped. */
const rows = doc
    .split("\n")
    .filter(
        (line) => line.startsWith("| ") && !line.startsWith("| App ") && !line.startsWith("| ---")
    )
    .map((line) =>
        line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim())
    );

/** Every subject the Subject column names, in backticks. */
const named = rows.flatMap((cells) =>
    [...(cells[2] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1])
);

describe("the sharing inventory", () => {
    it("has a row for each object, with a decision", () => {
        expect(rows.length).toBeGreaterThan(20);
        for (const cells of rows) {
            expect(cells).toHaveLength(8);
            expect(["fine", "add"].includes(cells[6]) || cells[6].startsWith("no:")).toBe(true);
        }
    });

    it("names only subjects a grant can be about", () => {
        for (const subject of named) expect(core.isGrantSubject(subject), subject).toBe(true);
    });

    it("names every subject a grant can be about", () => {
        for (const subject of core.GRANT_SUBJECTS) expect(named, subject).toContain(subject);
    });

    it("says why an object is not shareable", () => {
        for (const cells of rows.filter((one) => one[6].startsWith("no:"))) {
            expect(cells[6].length).toBeGreaterThan("no: ".length + 5);
        }
    });
});
