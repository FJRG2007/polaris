/**
 * What a comparison is, and what it refuses to pretend.
 *
 * The whole argument for this being its own kind rather than a spreadsheet is
 * that a claim carries its evidence and its date. So the cases here are mostly
 * about the two things a spreadsheet cannot do: say how old an answer is, and
 * refuse to invent one.
 */

import { describe, expect, it } from "vitest";
import * as comparison from "./comparison.js";
import type { Cell, Criterion, Subject } from "./comparison.js";

const US: Subject = { id: "s1", name: "Polaris", url: "", does: "", us: true };
const THEM: Subject = {
    id: "s2",
    name: "Acme",
    url: "https://acme.example",
    does: "",
    us: false
};

function cell(over: Partial<Cell> = {}): Cell {
    return { ...comparison.EMPTY_CELL, ...over };
}

describe("how old a claim is", () => {
    const now = new Date("2026-09-08T00:00:00Z");

    it("is stale once nobody has checked it for a quarter", () => {
        expect(comparison.isStale("2026-05-01T00:00:00Z", now)).toBe(true);
    });

    it("is not stale when somebody checked it recently", () => {
        expect(comparison.isStale("2026-08-20T00:00:00Z", now)).toBe(false);
    });

    it("is not stale when nobody has ever checked it", () => {
        // Unchecked and out of date are different facts and the table says them
        // differently: one is "nobody has looked", the other is "somebody looked
        // and it was a while ago".
        expect(comparison.isStale("", now)).toBe(false);
    });

    it("is not stale on a date nothing can read", () => {
        expect(comparison.isStale("whenever", now)).toBe(false);
    });
});

describe("how a cell reads", () => {
    it("turns a rating into the word for it", () => {
        expect(comparison.cellReads(cell({ value: "5" }), "rating")).toBe("Far ahead");
        expect(comparison.cellReads(cell({ value: "1" }), "rating")).toBe("Far behind");
    });

    it("keeps a rating nobody can name rather than dropping it", () => {
        expect(comparison.cellReads(cell({ value: "9" }), "rating")).toBe("9");
    });

    it("says partly, which is half the interesting answers", () => {
        expect(comparison.cellReads(cell({ value: "partial" }), "yesNo")).toBe("Partly");
    });

    it("says nothing for a cell nobody has answered", () => {
        expect(comparison.cellReads(comparison.EMPTY_CELL, "rating")).toBe("");
        expect(comparison.cellReads(comparison.EMPTY_CELL, "text")).toBe("");
    });
});

describe("the quadrant", () => {
    const cells = new Map<string, Cell>([
        [comparison.cellKey("s1", "c1"), cell({ value: "4" })],
        [comparison.cellKey("s1", "c2"), cell({ value: "5" })],
        [comparison.cellKey("s2", "c1"), cell({ value: "2" })]
        // s2 has no answer on c2 at all.
    ]);

    it("plots whoever has both answers", () => {
        const points = comparison.quadrantPoints([US, THEM], cells, "c1", "c2");
        expect(points).toEqual([{ subject: US, x: 4, y: 5 }]);
    });

    it("leaves out whoever is missing one rather than plotting them at zero", () => {
        // The failure this prevents: "not known" drawn at the origin reads as
        // "worst", which is a claim nobody made about them.
        const points = comparison.quadrantPoints([THEM], cells, "c1", "c2");
        expect(points).toEqual([]);
    });

    it("only offers an axis to something that has a position", () => {
        expect(comparison.isAxisKind("rating")).toBe(true);
        expect(comparison.isAxisKind("number")).toBe(true);
        expect(comparison.isAxisKind("text")).toBe(false);
        expect(comparison.isAxisKind("yesNo")).toBe(false);
    });
});

describe("what leaves in an export", () => {
    const criteria: Criterion[] = [
        { id: "c1", name: "Price", kind: "money", note: "", weight: 5 },
        { id: "c2", name: "SSO", kind: "yesNo", note: "", weight: 3 }
    ];
    const cells = new Map<string, Cell>([
        [comparison.cellKey("s1", "c1"), cell({ value: "£20" })],
        [comparison.cellKey("s2", "c1"), cell({ value: "£35", evidence: "Listed on their pricing page" })],
        [comparison.cellKey("s2", "c2"), cell({ value: "yes" })]
    ]);

    it("is the table, with the evidence attached to the claim", () => {
        // A table exported without its evidence is the rumour this whole kind
        // exists to avoid.
        expect(comparison.comparisonRows([US, THEM], criteria, cells)).toEqual([
            ["Criterion", "Polaris", "Acme"],
            ["Price", "£20", "£35 - Listed on their pricing page"],
            ["SSO", "", "Yes"]
        ]);
    });

    it("has a row per criterion even where nobody has answered", () => {
        const rows = comparison.comparisonRows([US], [criteria[1]!], new Map());
        expect(rows).toEqual([
            ["Criterion", "Polaris"],
            ["SSO", ""]
        ]);
    });
});

describe("the key a cell is stored under", () => {
    it("is one function, so a table cannot lose a column to a separator", () => {
        expect(comparison.cellKey("a", "b")).toBe("a::b");
        // Ids are uuids here, but the separator must not be one a name could
        // contain either.
        expect(comparison.cellKey("a:1", "b")).not.toBe(comparison.cellKey("a", "1:b"));
    });
});

describe("a positioning map", () => {
    const subjects: Subject[] = [
        { id: "a", name: "Acme", url: "", does: "", us: false },
        { id: "b", name: "Byte", url: "", does: "", us: false },
        { id: "c", name: "Cirrus", url: "", does: "", us: true }
    ];
    const on = (entries: [string, string, string][]) =>
        new Map(
            entries.map(([subject, criterion, value]) => [
                comparison.cellKey(subject, criterion),
                { ...comparison.EMPTY_CELL, value }
            ])
        );

    it("places everybody who answered both axes", () => {
        const map = comparison.perceptualMap(
            subjects,
            on([
                ["a", "price", "10"],
                ["a", "ease", "1"],
                ["b", "price", "50"],
                ["b", "ease", "5"],
                ["c", "price", "30"],
                ["c", "ease", "3"]
            ]),
            "price",
            "ease"
        );
        expect(map.points).toHaveLength(3);
        expect(map.missing).toBe(0);
    });

    it("draws the axis over the answers rather than over the scale", () => {
        // The whole reason this exists: a price axis fixed at 0-5 would put
        // every competitor in one corner.
        const map = comparison.perceptualMap(
            subjects.slice(0, 2),
            on([
                ["a", "price", "1000"],
                ["a", "ease", "1"],
                ["b", "price", "1200"],
                ["b", "ease", "5"]
            ]),
            "price",
            "ease"
        );
        expect(map.across).toEqual({ low: 1000, high: 1200 });
        expect(map.points[0]?.left).toBe(0);
        expect(map.points[1]?.left).toBe(1);
    });

    it("puts everybody down the middle when they all answered the same", () => {
        // A real state, and dividing by it is not.
        const map = comparison.perceptualMap(
            subjects.slice(0, 2),
            on([
                ["a", "price", "10"],
                ["a", "ease", "3"],
                ["b", "price", "10"],
                ["b", "ease", "3"]
            ]),
            "price",
            "ease"
        );
        expect(map.points.every((one) => one.left === 0.5 && one.up === 0.5)).toBe(true);
        expect(map.points.every((one) => Number.isFinite(one.left))).toBe(true);
    });

    it("leaves out anybody who has not answered, and says how many", () => {
        // Plotting them at zero would read as "worst", which is a claim nobody
        // made - and a chart quietly showing fewer than the table is worse.
        const map = comparison.perceptualMap(
            subjects,
            on([
                ["a", "price", "10"],
                ["a", "ease", "1"],
                ["b", "price", "50"]
            ]),
            "price",
            "ease"
        );
        expect(map.points.map((one) => one.subject.id)).toEqual(["a"]);
        expect(map.missing).toBe(2);
    });

    it("has nothing to place when nobody has answered", () => {
        const map = comparison.perceptualMap(subjects, new Map(), "price", "ease");
        expect(map.points).toEqual([]);
        expect(map.missing).toBe(3);
    });
});

describe("which criteria can be an axis", () => {
    it("is the ones with a position on a line", () => {
        expect(comparison.isAxisKind("rating")).toBe(true);
        expect(comparison.isAxisKind("number")).toBe(true);
        expect(comparison.isAxisKind("money")).toBe(true);
    });

    it("is never a sentence, which has no position", () => {
        expect(comparison.isAxisKind("text")).toBe(false);
        expect(comparison.isAxisKind("yesNo")).toBe(false);
    });
});
