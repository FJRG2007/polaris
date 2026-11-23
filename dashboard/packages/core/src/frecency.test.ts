import * as frecency from "./frecency";
import { describe, expect, it } from "vitest";

const DAY = 24 * 60 * 60 * 1000;

describe("frecency", () => {
    it("halves a score every half-life", () => {
        const record = { key: "a", score: 4, at: 0 };
        expect(frecency.frecency(record, 0)).toBe(4);
        expect(frecency.frecency(record, frecency.FRECENCY_HALF_LIFE_MS)).toBeCloseTo(2);
        expect(frecency.frecency(record, 2 * frecency.FRECENCY_HALF_LIFE_MS)).toBeCloseTo(1);
    });

    it("never grows a score from a clock that went backwards", () => {
        expect(frecency.frecency({ key: "a", score: 3, at: 10 * DAY }, 0)).toBe(3);
    });

    it("adds one use on top of the decayed score", () => {
        let records = frecency.recordUse([], "a", 0);
        records = frecency.recordUse(records, "a", frecency.FRECENCY_HALF_LIFE_MS);
        expect(records).toEqual([{ key: "a", score: 1.5, at: frecency.FRECENCY_HALF_LIFE_MS }]);
    });

    it("ranks something used daily for a week above a one-off from yesterday", () => {
        let records: frecency.UseRecord[] = [];
        for (let day = 0; day < 7; day += 1) records = frecency.recordUse(records, "daily", day * DAY);
        records = frecency.recordUse(records, "once", 8 * DAY);
        const scores = frecency.frecencyByKey(records, 9 * DAY);
        expect(scores.get("daily")!).toBeGreaterThan(scores.get("once")!);
        expect(frecency.byFrecency(["once", "none", "daily"], (key) => key, scores)).toEqual(["daily", "once", "none"]);
    });

    it("keeps the order of unused items", () => {
        expect(frecency.byFrecency(["c", "a", "b"], (key) => key, new Map())).toEqual(["c", "a", "b"]);
    });

    it("drops the lowest ranked past the cap", () => {
        let records: frecency.UseRecord[] = [];
        for (let index = 0; index <= frecency.MAX_USE_RECORDS; index += 1) records = frecency.recordUse(records, `k${index}`, index);
        expect(records).toHaveLength(frecency.MAX_USE_RECORDS);
        expect(records.some((record) => record.key === "k0")).toBe(false);
    });

    it("ignores an empty or oversized key", () => {
        expect(frecency.recordUse([], "", 0)).toEqual([]);
        expect(frecency.recordUse([], "x".repeat(frecency.MAX_USE_KEY + 1), 0)).toEqual([]);
    });

    it("reads a stored list total, dropping what is malformed", () => {
        expect(frecency.readUseRecords(null)).toEqual([]);
        expect(frecency.readUseRecords({ key: "a" })).toEqual([]);
        expect(
            frecency.readUseRecords([
                { key: "a", score: 2, at: 5 },
                { key: "a", score: 9, at: 5 },
                { key: "", score: 1, at: 1 },
                { key: "b", score: Number.NaN, at: 1 },
                { key: "c", score: 1, at: -1 },
                { key: "d", score: -1, at: 1 },
                "e",
                { key: "f", score: 1, at: 2 }
            ])
        ).toEqual([
            { key: "a", score: 2, at: 5 },
            { key: "f", score: 1, at: 2 }
        ]);
    });
});
