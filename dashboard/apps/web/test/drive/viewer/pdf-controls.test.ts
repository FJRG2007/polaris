/** What the PDF viewer's zoom, page box and search count read. */

import { describe, expect, it } from "vitest";
import {
    matchSummary,
    pageFromInput,
    zoomChoices,
    zoomLabel
} from "../../../src/app/(app)/drive/viewer/pdf-controls";

describe("zoomLabel", () => {
    it("names the preset in force", () => {
        expect(zoomLabel(1.42, "page-width")).toBe("Fit width");
        expect(zoomLabel(1, "auto")).toBe("Automatic");
    });

    it("reads the magnification once stepping has left every preset", () => {
        expect(zoomLabel(1.42)).toBe("142%");
        expect(zoomLabel(0.5)).toBe("50%");
    });
});

describe("zoomChoices", () => {
    it("selects the preset without inventing an option for it", () => {
        const { value, options } = zoomChoices(1.42, "page-width");
        expect(value).toBe("page-width");
        expect(options.filter((option) => option.value === "page-width")).toHaveLength(1);
    });

    it("selects a listed magnification rather than adding a second entry", () => {
        const { value, options } = zoomChoices(1.5);
        expect(value).toBe("1.5");
        expect(options.filter((option) => option.value === "1.5")).toHaveLength(1);
    });

    it("carries a stepped magnification that is on no list", () => {
        const { value, options } = zoomChoices(1.42);
        expect(value).toBe("1.42");
        expect(options.at(-1)).toEqual({ value: "1.42", label: "142%" });
    });
});

describe("pageFromInput", () => {
    it("takes a page this document has", () => {
        expect(pageFromInput("3", 10)).toBe(3);
        expect(pageFromInput("  7 ", 10)).toBe(7);
    });

    it("refuses anything that names no page", () => {
        expect(pageFromInput("", 10)).toBeNull();
        expect(pageFromInput("0", 10)).toBeNull();
        expect(pageFromInput("11", 10)).toBeNull();
        expect(pageFromInput("last", 10)).toBeNull();
    });

    it("refuses a number with anything else attached to it", () => {
        expect(pageFromInput("3abc", 10)).toBeNull();
        expect(pageFromInput("12-14", 20)).toBeNull();
        expect(pageFromInput("2.5", 10)).toBeNull();
    });
});

describe("matchSummary", () => {
    it("says nothing at all over an empty box", () => {
        expect(matchSummary("idle", 0, 0)).toBe("");
    });

    it("separates a document still being read from one with no matches in it", () => {
        expect(matchSummary("pending", 0, 0)).toBe("Searching...");
        expect(matchSummary("not-found", 0, 0)).toBe("No matches");
    });

    it("counts where the reader is", () => {
        expect(matchSummary("found", 3, 12)).toBe("3 of 12");
        expect(matchSummary("wrapped", 1, 12)).toBe("1 of 12");
    });
});
