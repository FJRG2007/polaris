/**
 * The media editor's edits are data: rotating turns the crop and every mark with
 * the picture, a crop can be dragged but never off the picture or to nothing,
 * and Send is one message unless an item has words of its own.
 */

import { describe, expect, it } from "vitest";
import * as edits from "@/app/(app)/chat/media-edit";

const photo = (name = "a.jpg", type = "image/jpeg") => new File(["x"], name, { type });

describe("rotating", () => {
    it("turns a point and a rectangle a quarter clockwise", () => {
        expect(edits.rotatePoint([0, 0])).toEqual([1, 0]);
        expect(edits.rotatePoint([0.25, 0.5])).toEqual([0.5, 0.25]);
        expect(edits.rotateRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({
            x: 1 - 0.2 - 0.4,
            y: 0.1,
            w: 0.4,
            h: 0.3
        });
    });

    it("comes back where it started after four turns, marks included", () => {
        const start: edits.PictureEdit = {
            rotation: 0,
            crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
            marks: [
                { kind: "stroke", color: "#fff", width: 0.01, points: [[0.2, 0.3], [0.4, 0.6]] },
                { kind: "text", text: "hi", color: "#fff", x: 0.7, y: 0.1, size: 0.08 }
            ]
        };
        let edit = start;
        for (let turn = 0; turn < 4; turn += 1) edit = edits.rotateEdit(edit);
        expect(edit.rotation).toBe(0);
        expect(edit.crop.x).toBeCloseTo(0.1);
        expect(edit.crop.w).toBeCloseTo(0.5);
        const text = edit.marks[1] as edits.TextMark;
        expect(text.x).toBeCloseTo(0.7);
        expect(text.y).toBeCloseTo(0.1);
        expect(edits.rotateEdit(start).rotation).toBe(90);
    });

    it("swaps the sides of the written file a quarter turn", () => {
        const turned = edits.rotateEdit(edits.NO_EDIT);
        expect(edits.outputSize(400, 300, turned)).toEqual({ width: 300, height: 400 });
    });
});

describe("cropping", () => {
    it("moves inside the picture only", () => {
        const crop = edits.dragCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, "move", 0.5, -1);
        expect(crop.x).toBeCloseTo(0.6);
        expect(crop.y).toBe(0);
        expect(crop.w).toBe(0.4);
    });

    it("keeps the opposite corner and a smallest size", () => {
        const crop = edits.dragCrop(edits.FULL_CROP, "se", -2, -0.5);
        expect(crop.x).toBe(0);
        expect(crop.w).toBeCloseTo(edits.MIN_CROP);
        expect(crop.h).toBeCloseTo(0.5);
        const grown = edits.dragCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, "nw", -1, -1);
        expect(grown).toEqual({ x: 0, y: 0, w: 0.7, h: 0.7 });
    });

    it("writes only the crop, and never past the longest side", () => {
        const edit = { ...edits.NO_EDIT, crop: { x: 0, y: 0, w: 0.5, h: 1 } };
        expect(edits.outputSize(1000, 500, edit)).toEqual({ width: 500, height: 500 });
        expect(edits.outputSize(10000, 5000, edits.NO_EDIT).width).toBe(edits.MAX_EDITED_SIDE);
    });

    it("maps a point on the cropped view back to the whole picture", () => {
        expect(edits.fromView({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, 0.5, 2)).toEqual([0.75, 0.5]);
    });
});

describe("what counts as edited", () => {
    it("is nothing until something changes", () => {
        expect(edits.isEdited(edits.NO_EDIT)).toBe(false);
        expect(edits.isEdited(edits.rotateEdit(edits.NO_EDIT))).toBe(true);
        expect(edits.isEdited({ ...edits.NO_EDIT, crop: { x: 0, y: 0, w: 1, h: 0.9 } })).toBe(true);
    });

    it("leaves an animated or vector picture alone", () => {
        expect(edits.canEditPicture("image/jpeg")).toBe(true);
        expect(edits.canEditPicture("image/gif")).toBe(false);
        expect(edits.canEditPicture("image/svg+xml")).toBe(false);
        expect(edits.canEditPicture("video/mp4")).toBe(false);
    });

    it("names the new file for what it is written as", () => {
        expect(edits.editedName("IMG_1.HEIC", "image/heic")).toBe("IMG_1.jpg");
        expect(edits.editedName("shot.png", "image/png")).toBe("shot.png");
        expect(edits.editedName(".png", "image/webp")).toBe("photo.webp");
    });

    it("finds the text under a finger", () => {
        const marks: edits.Mark[] = [
            { kind: "text", text: "hello", color: "#fff", x: 0.5, y: 0.5, size: 0.1 }
        ];
        expect(edits.textAt(marks, 0.5, 0.5, 1)).toBe(0);
        expect(edits.textAt(marks, 0.05, 0.05, 1)).toBe(-1);
    });
});

describe("sending", () => {
    it("is one message with every item when nothing is captioned", () => {
        const [a, b] = [photo("a.jpg"), new File(["x"], "b.mp4", { type: "video/mp4" })];
        const plan = edits.planMediaSend(
            [
                { file: a, caption: " ", captured: "camera" },
                { file: b, caption: "", captured: null }
            ],
            true
        );
        expect(plan).toHaveLength(1);
        expect(plan[0]!.files).toEqual([a, b]);
        expect(plan[0]!.body).toBe("");
        expect(plan[0]!.viewOnce).toEqual([
            { index: 0, seconds: 10, captured: "camera" },
            { index: 1, seconds: null, captured: null }
        ]);
    });

    it("is a message per item, each with its own words, once one is captioned", () => {
        const [a, b] = [photo("a.jpg"), photo("b.jpg")];
        const plan = edits.planMediaSend(
            [
                { file: a, caption: "  look  ", captured: null },
                { file: b, caption: "", captured: null }
            ],
            false
        );
        expect(plan.map((one) => one.body)).toEqual(["look", ""]);
        expect(plan.map((one) => one.files)).toEqual([[a], [b]]);
        expect(plan.every((one) => one.viewOnce.length === 0)).toBe(true);
    });

    it("is nothing for nothing", () => {
        expect(edits.planMediaSend([], true)).toEqual([]);
    });
});
