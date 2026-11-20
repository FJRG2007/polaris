/**
 * The size and blur a sender measures for a picture, and what the server lets
 * through of it. It is client data every other reader's browser decodes, so a
 * shape that does not check out is dropped - never kept, never a refusal.
 */

import { describe, expect, it } from "vitest";
import {
    encodeThumbHash,
    fittedSize,
    isThumbHash,
    placeholderUrl,
    readMediaShapes,
    writeMediaShape
} from "@/lib/chat/media-shape";
import { withoutFiles } from "@/app/(app)/chat/outgoing";

/** A real ThumbHash of a 4x2 picture, half red and half blue. */
function sampleHash(): string {
    const rgba: number[] = [];
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 4; x++) rgba.push(x < 2 ? 255 : 0, 0, x < 2 ? 0 : 255, 255);
    }
    return encodeThumbHash(4, 2, rgba);
}

describe("media shapes", () => {
    it("round-trips a hash the browser made", () => {
        const hash = sampleHash();
        expect(isThumbHash(hash)).toBe(true);
        const written = writeMediaShape({ width: 4000, height: 2000, thumbhash: hash });
        expect(readMediaShapes(JSON.stringify([written, null]))).toEqual([
            { width: 4000, height: 2000, thumbhash: hash },
            null
        ]);
        expect(placeholderUrl(hash)).toMatch(/^data:image\/png;base64,/);
    });

    it("drops what does not check out, entry by entry", () => {
        const hash = sampleHash();
        const read = readMediaShapes(
            JSON.stringify([
                { w: 0, h: 10, th: hash },
                { w: 10, h: 10, th: "not base64!" },
                { w: 10, h: 10, th: "QUJD" },
                { w: 10, h: 10, th: "A".repeat(200) },
                { w: 10, h: 10, extra: 1 },
                { w: 10.5, h: 10 },
                { w: 10, h: 10 }
            ])
        );
        expect(read).toEqual([null, null, null, null, null, null, { width: 10, height: 10, thumbhash: null }]);
    });

    it("answers nothing for a field that is not a list", () => {
        expect(readMediaShapes(null)).toEqual([]);
        expect(readMediaShapes("{")).toEqual([]);
        expect(readMediaShapes('{"w":1}')).toEqual([]);
        expect(readMediaShapes("x".repeat(9000))).toEqual([]);
    });

    it("fits a picture into the bubble, never upscaling it", () => {
        const box = { width: 320, height: 288 };
        expect(fittedSize(4000, 3000, box)).toEqual({ width: 320, height: 240 });
        expect(fittedSize(1080, 1920, box)).toEqual({ width: 162, height: 288 });
        expect(fittedSize(100, 50, box)).toEqual({ width: 100, height: 50 });
        expect(fittedSize(null, 50, box)).toBeNull();
    });
});

describe("taking a file out of a message on its way", () => {
    const file = (name: string) => new File(["x"], name, { type: "image/png" });

    it("moves the covered positions and the seen-once choices with the files", () => {
        const files = [file("a"), file("b"), file("c")];
        const left = withoutFiles(
            {
                files,
                // b covered, and the first Drive pick after the three files.
                hidden: [1, 3],
                viewOnce: [{ index: 2, seconds: null, captured: null }],
                staged: ["id-a", null, "id-c"]
            },
            new Set([0])
        );
        expect(left.files.map((one) => one.name)).toEqual(["b", "c"]);
        expect(left.hidden).toEqual([0, 2]);
        expect(left.viewOnce).toEqual([{ index: 1, seconds: null, captured: null }]);
        expect(left.staged).toEqual([null, "id-c"]);
    });

    it("drops a covered mark for the file that went", () => {
        const left = withoutFiles({ files: [file("a"), file("b")], hidden: [1] }, new Set([1]));
        expect(left.hidden).toEqual([]);
    });
});
