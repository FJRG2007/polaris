/**
 * The account's text size as the app reads it from the dashboard: only the sizes
 * the dashboard offers, the same list it keeps, and the scale the widget grows by.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_SIZE, readTextSize, TEXT_SIZES, textScale } from "@/shared/text-size";

describe("readTextSize", () => {
    it("reads the root element's value and a bare number", () => {
        expect(readTextSize("18px")).toBe(18);
        expect(readTextSize(" 24px ")).toBe(24);
        expect(readTextSize(20)).toBe(20);
    });

    it("refuses anything the dashboard does not offer", () => {
        for (const raw of ["17px", "1.2rem", "", "999px", "16px; color: red", null, undefined, 13, {}]) {
            expect(readTextSize(raw)).toBeNull();
        }
    });
});

describe("textScale", () => {
    it("is 1 at the default and grows with the size", () => {
        expect(textScale(DEFAULT_TEXT_SIZE)).toBe(1);
        expect(textScale(24)).toBe(1.5);
        expect(textScale(7)).toBe(1);
    });
});

describe("the sizes", () => {
    it("are the ones the dashboard offers, and its default", () => {
        const source = readFileSync(join(__dirname, "../../../dashboard/packages/core/src/schemas/display.ts"), "utf8");
        const offered = /TEXT_SIZES = \[([^\]]+)\]/.exec(source)?.[1]?.split(",").map((size) => Number(size.trim()));
        expect(offered).toEqual([...TEXT_SIZES]);
        expect(source).toContain(`textSize: ${DEFAULT_TEXT_SIZE}\n`);
    });
});
