/** The picker's per-person order and its "Recent" group. */

import { describe, expect, it } from "vitest";
import {
    applyOrder,
    moveBy,
    moveTo,
    pickerOrderBodySchema,
    rankRecent
} from "@/lib/polar/picker-order";

const id = (key: string) => key;

describe("the stored order", () => {
    it("lists ordered keys first and keeps the rest in their own order", () => {
        expect(applyOrder(["a", "b", "c", "d"], id, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
        expect(applyOrder(["a", "b"], id, [])).toEqual(["a", "b"]);
        expect(applyOrder(["a", "b"], id, ["gone", "b"])).toEqual(["b", "a"]);
    });

    it("moves one step, or to a place, and keeps keys not shown", () => {
        expect(moveBy([], ["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
        expect(moveBy(["x"], ["a", "b"], "a", 1)).toEqual(["b", "a", "x"]);
        expect(moveBy([], ["a", "b"], "a", -1)).toEqual(["a", "b"]);
        expect(moveTo([], ["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
        expect(moveTo(["q"], ["a"], "missing", 0)).toEqual(["q"]);
    });

    it("validates what is stored", () => {
        expect(pickerOrderBodySchema.parse({ order: ["a", "a", " b "] })).toEqual({ order: ["a", "b"] });
        expect(pickerOrderBodySchema.safeParse({ order: [""] }).success).toBe(false);
        expect(pickerOrderBodySchema.safeParse({ order: Array.from({ length: 201 }, (_, i) => `k${i}`) }).success).toBe(false);
        expect(pickerOrderBodySchema.safeParse({ order: "a" }).success).toBe(false);
    });
});

describe("Recent", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const at = (days: number) => new Date(now.getTime() - days * 86_400_000);

    it("ranks by use, weighted to the recent, one entry per source and model, at most five", () => {
        const uses = [
            ...Array.from({ length: 6 }, () => ({ source: "polar:openrouter", provider: "openrouter", model: "a", at: at(1) })),
            { source: "account:p", provider: "anthropic", model: "opus", at: at(0) },
            { source: "account:p", provider: "anthropic", model: "opus", at: at(0) },
            // Many uses, but long ago.
            ...Array.from({ length: 6 }, () => ({ source: "polar:groq", provider: "groq", model: "old", at: at(120) })),
            ...["b", "c", "d", "e"].map((model) => ({ source: "polar:openrouter", provider: "openrouter", model, at: at(2) }))
        ];
        const ranked = rankRecent(uses, now);
        expect(ranked).toHaveLength(5);
        expect(ranked[0]).toEqual({ source: "polar:openrouter", provider: "openrouter", model: "a" });
        expect(ranked[1]).toEqual({ source: "account:p", provider: "anthropic", model: "opus" });
        expect(ranked.some((pick) => pick.model === "old")).toBe(false);
        // The same model from two sources is two entries.
        expect(
            rankRecent(
                [
                    { source: "account:p", provider: "anthropic", model: "opus", at: at(0) },
                    { source: "polar:anthropic", provider: "anthropic", model: "opus", at: at(0) }
                ],
                now
            )
        ).toHaveLength(2);
    });
});
