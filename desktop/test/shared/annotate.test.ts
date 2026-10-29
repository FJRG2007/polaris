import { describe, expect, it } from "vitest";
import { addShown, FADE_MS, HOLD_MS, shownAlpha, strokeSchema, type ShownStroke } from "@/shared/annotate";

describe("strokes shown over a shared display", () => {
    it("takes a stroke the dashboard believed, and nothing shaped otherwise", () => {
        const stroke = { key: "seat-1/abc", color: "#ef4444", points: [[0.5, 0.5]], end: false };
        expect(strokeSchema.safeParse(stroke).success).toBe(true);
        expect(strokeSchema.safeParse({ ...stroke, color: "red; background:url(x)" }).success).toBe(false);
        expect(strokeSchema.safeParse({ ...stroke, points: [[1.5, 0]] }).success).toBe(false);
        expect(strokeSchema.safeParse({ ...stroke, points: [[Number.NaN, 0]] }).success).toBe(false);
        expect(strokeSchema.safeParse({ ...stroke, extra: 1 }).success).toBe(false);
    });

    it("continues a stroke by its key", () => {
        const board = new Map<string, ShownStroke>();
        addShown(board, { key: "a/1", color: "#ffffff", points: [[0, 0]], end: false }, 0);
        addShown(board, { key: "a/1", color: "#ffffff", points: [[1, 1]], end: true }, 10);
        expect(board.size).toBe(1);
        expect(board.get("a/1")?.points).toEqual([
            [0, 0],
            [1, 1]
        ]);
        expect(board.get("a/1")?.last).toBe(10);
    });

    it("fades after it has been held", () => {
        const stroke: ShownStroke = { color: "#ffffff", points: [[0, 0]], last: 0 };
        expect(shownAlpha(stroke, HOLD_MS)).toBe(1);
        expect(shownAlpha(stroke, HOLD_MS + FADE_MS / 2)).toBeCloseTo(0.5);
        expect(shownAlpha(stroke, HOLD_MS + FADE_MS)).toBe(0);
    });
});
