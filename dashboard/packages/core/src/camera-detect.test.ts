/**
 * The arithmetic between a model's answer and a line in somebody's event list.
 *
 * None of this can be checked by looking at a camera. A grid decoded with the
 * rows in the wrong order, or a box put back without undoing the scale, does not
 * fail - it reports a person in the wrong half of the picture, on the wrong side
 * of a zone boundary, for as long as nobody compares the picture with the box
 * drawn on it. So the model's output convention is written down here as
 * synthetic tensors, and every step is exercised against a box whose right
 * answer is known before the code runs.
 */

import * as detect from "./camera-detect.js";
import fixture from "./camera-detect.fixture.json" with { type: "json" };
import { describe, expect, it } from "vitest";

/** Build one candidate row in the model's own convention. */
function row(input: {
    offsetX: number;
    offsetY: number;
    logWidth: number;
    logHeight: number;
    objectness: number;
    classIndex: number;
    classScore: number;
}): number[] {
    const values = new Array<number>(detect.ROW_LENGTH).fill(0);
    values[0] = input.offsetX;
    values[1] = input.offsetY;
    values[2] = input.logWidth;
    values[3] = input.logHeight;
    values[4] = input.objectness;
    values[5 + input.classIndex] = input.classScore;
    return values;
}

/** A whole output tensor of the right length, with one row filled in. */
function tensorWith(modelSize: number, rowIndex: number, filled: number[]): number[] {
    const output = new Array<number>(detect.candidateCount(modelSize) * detect.ROW_LENGTH).fill(0);
    for (let index = 0; index < filled.length; index += 1) output[rowIndex * detect.ROW_LENGTH + index] = filled[index]!;
    return output;
}

describe("how many boxes the model predicts", () => {
    it("counts one per cell of each of the three grids", () => {
        // 416: 52x52 + 26x26 + 13x13.
        expect(detect.candidateCount(416)).toBe(2704 + 676 + 169);
        expect(detect.candidateCount(640)).toBe(6400 + 1600 + 400);
    });
});

describe("decoding a row", () => {
    const SIZE = 64;

    it("puts a box at the cell the row belongs to", () => {
        // The first grid is stride 8, so 8x8 cells. Row 8 is the start of the
        // second row of cells: cell (0, 1).
        const filled = row({
            offsetX: 0.5,
            offsetY: 0.25,
            logWidth: Math.log(2),
            logHeight: Math.log(4),
            objectness: 0.9,
            classIndex: 0,
            classScore: 0.8
        });
        const decoded = detect.decodeDetections(tensorWith(SIZE, 8, filled), SIZE, 0.5);
        expect(decoded).toHaveLength(1);
        const box = decoded[0]!;
        // Centre: (0.5 + 0) * 8 = 4 across, (0.25 + 1) * 8 = 10 down.
        // Size: e^log2 * 8 = 16 wide, e^log4 * 8 = 32 tall.
        expect(box.x1).toBeCloseTo(-4);
        expect(box.y1).toBeCloseTo(-6);
        expect(box.x2).toBeCloseTo(12);
        expect(box.y2).toBeCloseTo(26);
        expect(box.classIndex).toBe(0);
        expect(box.score).toBeCloseTo(0.72);
    });

    it("reads the coarser grids after the fine one", () => {
        // Stride 16 starts after 8x8 = 64 rows. Its cell (1, 0) is row 65.
        const filled = row({
            offsetX: 0,
            offsetY: 0,
            logWidth: 0,
            logHeight: 0,
            objectness: 1,
            classIndex: 2,
            classScore: 1
        });
        const decoded = detect.decodeDetections(tensorWith(SIZE, 65, filled), SIZE, 0.5);
        expect(decoded).toHaveLength(1);
        // Centre (1, 0) at stride 16 is 16 across, 0 down; size e^0 * 16 = 16.
        expect(decoded[0]!.x1).toBeCloseTo(8);
        expect(decoded[0]!.y1).toBeCloseTo(-8);
        expect(decoded[0]!.classIndex).toBe(2);
    });

    it("drops a row the model was not confident about", () => {
        const weak = row({
            offsetX: 0,
            offsetY: 0,
            logWidth: 0,
            logHeight: 0,
            objectness: 0.9,
            classIndex: 0,
            classScore: 0.2
        });
        // 0.9 * 0.2 is under a half, so it never becomes a detection even though
        // the model was sure something was there.
        expect(detect.decodeDetections(tensorWith(SIZE, 0, weak), SIZE, 0.5)).toEqual([]);
    });

    it("takes the highest-scoring class of the row", () => {
        const filled = row({
            offsetX: 0,
            offsetY: 0,
            logWidth: 0,
            logHeight: 0,
            objectness: 1,
            classIndex: 0,
            classScore: 0.4
        });
        filled[5 + 16] = 0.9;
        const decoded = detect.decodeDetections(tensorWith(SIZE, 0, filled), SIZE, 0.5);
        expect(detect.COCO_LABELS[decoded[0]!.classIndex]).toBe("dog");
    });
});

describe("fitting a frame into the model's square", () => {
    it("scales by one factor and keeps the corner at the origin", () => {
        const box = detect.letterboxFor(1920, 1080, 416);
        expect(box.scale).toBeCloseTo(416 / 1920);
        expect(box.width).toBe(416);
        expect(box.height).toBe(234);
    });

    it("puts a box back where it came from, as a fraction of the frame", () => {
        const letterbox = detect.letterboxFor(1920, 1080, 416);
        // The middle of the picture inside the square.
        const middle = { x1: 208, y1: 117, x2: 208, y2: 117 };
        const frame = detect.modelBoxToFrame(middle, letterbox, 1920, 1080);
        expect(frame.x1).toBeCloseTo(0.5, 2);
        expect(frame.y1).toBeCloseTo(0.5, 2);
    });

    it("keeps a box inside the frame even when the model ran off the edge", () => {
        const letterbox = detect.letterboxFor(640, 640, 416);
        const frame = detect.modelBoxToFrame({ x1: -40, y1: -40, x2: 900, y2: 900 }, letterbox, 640, 640);
        expect(frame).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 });
    });
});

describe("dropping the duplicates around one real thing", () => {
    const at = (x: number, score: number, classIndex = 0): detect.ModelDetection => ({
        classIndex,
        score,
        x1: x,
        y1: 0,
        x2: x + 100,
        y2: 100
    });

    it("keeps the best of a cluster", () => {
        const kept = detect.suppressOverlaps([at(0, 0.7), at(5, 0.9), at(10, 0.6)]);
        expect(kept).toHaveLength(1);
        expect(kept[0]!.score).toBe(0.9);
    });

    it("keeps two things that are genuinely apart", () => {
        expect(detect.suppressOverlaps([at(0, 0.9), at(400, 0.8)])).toHaveLength(2);
    });

    it("keeps two classes in the same place, because a person carrying a bag is both", () => {
        expect(detect.suppressOverlaps([at(0, 0.9, 0), at(0, 0.8, 24)])).toHaveLength(2);
    });
});

describe("what a house calls it", () => {
    it("folds the research classes into the four that get reported", () => {
        expect(detect.houseClassOf("person")).toBe("person");
        expect(detect.houseClassOf("truck")).toBe("vehicle");
        expect(detect.houseClassOf("cat")).toBe("animal");
        expect(detect.houseClassOf("suitcase")).toBe("package");
    });

    it("has no opinion about the rest of the dataset", () => {
        expect(detect.houseClassOf("potted plant")).toBeNull();
        expect(detect.houseClassOf("toothbrush")).toBeNull();
    });

    it("keeps person at index zero, which the whole labelling rests on", () => {
        expect(detect.COCO_LABELS[0]).toBe("person");
        expect(detect.COCO_LABELS).toHaveLength(80);
    });
});

describe("the camera's own filters", () => {
    const person = detect.DEFAULT_FILTERS.person!;

    it("accepts somebody standing in the picture", () => {
        expect(detect.passesFilter({ x1: 0.4, y1: 0.3, x2: 0.5, y2: 0.8 }, 0.8, person)).toBe(true);
    });

    it("rejects a stripe of wet road that the model called a person", () => {
        expect(detect.passesFilter({ x1: 0.1, y1: 0.7, x2: 0.9, y2: 0.75 }, 0.8, person)).toBe(false);
    });

    it("rejects something too far away to be worth a line", () => {
        expect(detect.passesFilter({ x1: 0.5, y1: 0.5, x2: 0.51, y2: 0.52 }, 0.8, person)).toBe(false);
    });

    it("rejects a box that covers the whole lens", () => {
        expect(detect.passesFilter({ x1: 0, y1: 0, x2: 1, y2: 1 }, 0.9, person)).toBe(false);
    });
});

describe("the whole way through", () => {
    const SIZE = 64;

    it("reports a person the camera asked about, in frame coordinates", () => {
        // A box around the middle of a square frame: centre (32, 32), 8 wide,
        // 24 tall - a person-shaped thing covering a fortieth of the picture.
        const filled = row({
            offsetX: 0,
            offsetY: 0,
            logWidth: Math.log(1),
            logHeight: Math.log(3),
            objectness: 0.95,
            classIndex: 0,
            classScore: 0.9
        });
        // Stride 8, cell (4, 4) is row 4 * 8 + 4 = 36, centre (32, 32).
        const found = detect.readDetections({
            output: tensorWith(SIZE, 36, filled),
            modelSize: SIZE,
            sourceWidth: 640,
            sourceHeight: 640,
            classes: ["person"]
        });
        expect(found).toHaveLength(1);
        expect(found[0]!.houseClass).toBe("person");
        expect(found[0]!.box.x1).toBeCloseTo(0.4375);
        expect(found[0]!.box.y1).toBeCloseTo(0.3125);
    });

    it("says nothing about a class the camera was not asked to report", () => {
        const filled = row({
            offsetX: 0,
            offsetY: 0,
            logWidth: Math.log(1),
            logHeight: Math.log(3),
            objectness: 0.95,
            classIndex: 0,
            classScore: 0.9
        });
        expect(
            detect.readDetections({
                output: tensorWith(SIZE, 36, filled),
                modelSize: SIZE,
                sourceWidth: 640,
                sourceHeight: 640,
                classes: ["vehicle"]
            })
        ).toEqual([]);
    });

    it("says nothing at all when the camera cares about nothing", () => {
        expect(
            detect.readDetections({
                output: new Array(detect.candidateCount(SIZE) * detect.ROW_LENGTH).fill(1),
                modelSize: SIZE,
                sourceWidth: 640,
                sourceHeight: 640,
                classes: []
            })
        ).toEqual([]);
    });
});

describe("against the model itself", () => {
    /**
     * Six candidate rows lifted out of a real run of the model this worker
     * ships, together with what the model's own reference implementation makes
     * of them.
     *
     * This is the one thing in the module that could not be reasoned about. The
     * output layout - which grid a row belongs to, whether the coordinates are
     * offsets or pixels, whether the sizes are logarithms - is a convention, and
     * a convention got wrong produces boxes in the wrong place rather than an
     * error. So the numbers here came out of the model, the answers came out of
     * the implementation that ships with it, and this asserts the two agree.
     *
     * Only the rows that carried a candidate are kept: the rest of the tensor is
     * zeroes, and a zero row cannot pass the score floor, so reconstructing it
     * that way changes nothing and keeps the fixture at a few kilobytes rather
     * than a megabyte.
     */
    const tensor = (() => {
        const output = new Float32Array(detect.candidateCount(fixture.modelSize) * detect.ROW_LENGTH);
        for (const row of fixture.rows) {
            output.set(row.values, row.index * detect.ROW_LENGTH);
        }
        return output;
    })();

    it("decodes a real tensor exactly as the model's own implementation does", () => {
        const mine = detect
            .decodeDetections(tensor, fixture.modelSize, fixture.minScore)
            .sort((a, b) => b.score - a.score);
        expect(mine).toHaveLength(fixture.expected.length);
        mine.forEach((found, index) => {
            const expected = fixture.expected[index]!;
            expect(found.classIndex).toBe(expected.classIndex);
            expect(found.score).toBeCloseTo(expected.score, 4);
            expect(found.x1).toBeCloseTo(expected.box[0]!, 2);
            expect(found.y1).toBeCloseTo(expected.box[1]!, 2);
            expect(found.x2).toBeCloseTo(expected.box[2]!, 2);
            expect(found.y2).toBeCloseTo(expected.box[3]!, 2);
        });
    });

    it("counts the rows the model actually produces", () => {
        expect(detect.candidateCount(416) * detect.ROW_LENGTH).toBe(3549 * 85);
    });
});
