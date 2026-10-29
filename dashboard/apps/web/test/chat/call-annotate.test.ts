/**
 * Drawing on a shared screen: who may, what is believed, and where a point
 * lands on a letterboxed picture.
 */

import { describe, expect, it } from "vitest";
import * as annotation from "@/lib/chat/call-annotate";
import type { Board, StrokeMessage } from "@/lib/chat/call-annotate";

const stroke = (points: StrokeMessage["points"], end = false): StrokeMessage => ({
    kind: "stroke",
    on: "presenter",
    id: "abc",
    color: 0,
    points,
    end
});

describe("who may draw", () => {
    it("reads the sharer's attribute, valid seats only", () => {
        expect(annotation.annotatorsOf(undefined)).toEqual([]);
        expect(annotation.annotatorsOf({ annotators: "" })).toEqual([]);
        expect(annotation.annotatorsOf({ annotators: "a,b, c,d\u0007" })).toEqual(["a", "b"]);
    });

    it("writes each seat once", () => {
        expect(annotation.annotatorsAttribute(["a", "b", "a"])).toBe("a,b");
        expect(annotation.annotatorsAttribute(["bad seat", "ok"])).toBe("ok");
    });

    it("believes a stroke only from a seat the sharer named, never the sharer's own", () => {
        expect(annotation.mayDraw("viewer", "presenter", ["viewer"])).toBe(true);
        expect(annotation.mayDraw("stranger", "presenter", ["viewer"])).toBe(false);
        expect(annotation.mayDraw("presenter", "presenter", ["presenter"])).toBe(false);
    });
});

describe("messages", () => {
    it("parses each kind strictly", () => {
        const parse = (raw: unknown) => annotation.annotateMessageSchema.safeParse(raw).success;
        expect(parse({ kind: "draw-ask" })).toBe(true);
        expect(parse({ kind: "draw-answer", allowed: true })).toBe(true);
        expect(parse(stroke([[0.1, 0.2]]))).toBe(true);
        expect(parse({ ...stroke([[0.1, 0.2]]), color: 99 })).toBe(false);
        expect(parse(stroke([[1.2, 0.2]]))).toBe(false);
        expect(parse(stroke([]))).toBe(false);
        expect(parse({ ...stroke([[0, 0]]), style: "x" })).toBe(false);
        expect(parse(stroke(Array.from({ length: 65 }, () => [0, 0] as [number, number])))).toBe(
            false
        );
    });
});

describe("the board", () => {
    it("continues one sender's stroke and keeps two senders apart", () => {
        const board: Board = new Map();
        annotation.addStroke(board, "a", stroke([[0, 0]]), 0);
        annotation.addStroke(board, "a", stroke([[1, 1]], true), 5);
        annotation.addStroke(board, "b", stroke([[0.5, 0.5]]), 5);
        expect(board.size).toBe(2);
        expect(board.get("a/abc")?.points).toHaveLength(2);
    });

    it("forgets strokes once they have faded", () => {
        const board: Board = new Map();
        annotation.addStroke(board, "a", stroke([[0, 0]]), 0);
        expect(annotation.pruneBoard(board, annotation.HOLD_MS)).toBe(true);
        expect(annotation.pruneBoard(board, annotation.HOLD_MS + annotation.FADE_MS)).toBe(false);
        expect(board.size).toBe(0);
    });
});

describe("where a point lands", () => {
    // A 16:9 picture letterboxed in a square: bars above and below.
    const box = { left: 0, top: 0, width: 160, height: 160 };

    it("maps the picture's corners to 0 and 1", () => {
        expect(annotation.toPicture(0, 35, box, 16 / 9)).toEqual([0, 0]);
        expect(annotation.toPicture(160, 125, box, 16 / 9)).toEqual([1, 1]);
        expect(annotation.toPicture(80, 80, box, 16 / 9)).toEqual([0.5, 0.5]);
    });

    it("refuses a point on the bars", () => {
        expect(annotation.toPicture(80, 10, box, 16 / 9)).toBeNull();
    });

    it("uses the whole box while the picture's shape is unknown", () => {
        expect(annotation.toPicture(80, 10, box, null)).toEqual([0.5, 0.0625]);
    });
});
