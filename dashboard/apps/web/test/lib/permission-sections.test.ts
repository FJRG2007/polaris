/**
 * The folding permission lists: filing under areas, the search that narrows
 * them, which areas are open, and the remembered choices read back.
 */

import { describe, expect, it } from "vitest";
import {
    filterSections,
    foldText,
    groupByArea,
    openSections,
    parseChosen
} from "@/lib/permission-sections";

const sections = [
    {
        id: "Drive",
        label: "Drive",
        items: [
            { id: "drive.read", label: "See files", held: true },
            { id: "drive.write", label: "Edit files", held: false }
        ]
    },
    {
        id: "Office",
        label: "Oficina",
        items: [{ id: "office.write", label: "Edición de documentos", held: false }]
    }
];

describe("groupByArea", () => {
    it("keeps areas and entries in first-seen order", () => {
        const grouped = groupByArea(["a1", "b1", "a2"], (item) => item[0]!);
        expect(grouped).toEqual([
            ["a", ["a1", "a2"]],
            ["b", ["b1"]]
        ]);
    });
});

describe("filterSections", () => {
    it("returns everything with no query and no filter", () => {
        expect(filterSections(sections, "  ")).toEqual(sections);
    });

    it("matches a label, ignoring case and accents, and hides areas with no match", () => {
        const result = filterSections(sections, "EDICION");
        expect(result.map((section) => section.id)).toEqual(["Office"]);
    });

    it("matches a permission key", () => {
        const result = filterSections(sections, "drive.wr");
        expect(result).toHaveLength(1);
        expect(result[0]!.items.map((item) => item.id)).toEqual(["drive.write"]);
    });

    it("brings a whole area when its own name matches", () => {
        const result = filterSections(sections, "drive");
        expect(result[0]!.items).toHaveLength(2);
    });

    it("applies the extra filter with and without a query", () => {
        expect(filterSections(sections, "", (item) => "held" in item && item.held === true)).toEqual([
            { ...sections[0], items: [sections[0]!.items[0]] }
        ]);
        expect(filterSections(sections, "edit", (item) => "held" in item && item.held === true)).toEqual(
            []
        );
    });

    it("returns nothing when nothing matches", () => {
        expect(filterSections(sections, "zzz")).toEqual([]);
    });
});

describe("openSections", () => {
    it("prefers the reader's choice over the default", () => {
        const open = openSections(["a", "b", "c"], { a: false, c: true }, (id) => id !== "c");
        expect([...open]).toEqual(["b", "c"]);
    });
});

describe("parseChosen", () => {
    it("reads booleans back and drops everything else", () => {
        expect(parseChosen("{\"a\":true,\"b\":\"x\",\"c\":false}")).toEqual({ a: true, c: false });
    });

    it("survives nothing stored, junk and the wrong shape", () => {
        expect(parseChosen(null)).toEqual({});
        expect(parseChosen("{not json")).toEqual({});
        expect(parseChosen("[true]")).toEqual({});
    });
});

describe("foldText", () => {
    it("lowers case and strips accents", () => {
        expect(foldText("Édición")).toBe("edicion");
    });
});
