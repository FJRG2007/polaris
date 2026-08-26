/**
 * What a recorded call looks like.
 *
 * The recording is composed onto a canvas in the browser of whoever pressed
 * record, which means the layout is arithmetic rather than a stylesheet - and
 * arithmetic that nobody sees until they watch the file back. A tile off the
 * edge, a strip with no height, or a division by a room of nobody all produce a
 * recording that is only wrong when it is too late to make it again.
 */

import { describe, expect, it } from "vitest";
import { recordingLayout, recordingTiles } from "@/app/(app)/chat/call-recorder";

const WIDTH = 1280;
const HEIGHT = 720;

describe("a room of faces", () => {
    it("gives one person the whole frame", () => {
        const { stage, faces } = recordingLayout(0, 1);
        expect(stage).toEqual([]);
        expect(faces).toEqual([{ x: 0, y: 0, width: WIDTH, height: HEIGHT }]);
    });

    it("cuts four people into a square grid that covers it exactly", () => {
        const { faces } = recordingLayout(0, 4);
        expect(faces).toHaveLength(4);
        expect(faces[0]).toEqual({ x: 0, y: 0, width: 640, height: 360 });
        expect(faces[3]).toEqual({ x: 640, y: 360, width: 640, height: 360 });
    });

    it("leaves nothing outside the frame at any size a call can reach", () => {
        for (let people = 1; people <= 8; people += 1) {
            for (const tile of recordingTiles(people, { x: 0, y: 0, width: WIDTH, height: HEIGHT })) {
                expect(tile.x).toBeGreaterThanOrEqual(0);
                expect(tile.y).toBeGreaterThanOrEqual(0);
                expect(tile.x + tile.width).toBeLessThanOrEqual(WIDTH);
                expect(tile.y + tile.height).toBeLessThanOrEqual(HEIGHT);
                expect(tile.width).toBeGreaterThan(0);
                expect(tile.height).toBeGreaterThan(0);
            }
        }
    });

    it("draws nobody rather than dividing by a room of nobody", () => {
        expect(recordingTiles(0, { x: 0, y: 0, width: WIDTH, height: HEIGHT })).toEqual([]);
        expect(recordingLayout(0, 0).faces).toEqual([]);
    });
});

describe("a screen being shared", () => {
    it("takes most of the frame, with the faces in a strip under it", () => {
        const { stage, faces } = recordingLayout(1, 3);
        expect(stage[0]).toEqual({ x: 0, y: 0, width: WIDTH, height: 540 });
        expect(faces).toHaveLength(3);
        expect(faces[0]?.y).toBe(540);
        expect(faces[0]?.height).toBe(180);
        expect(faces[2]?.x).toBeCloseTo((WIDTH / 3) * 2);
    });

    it("takes the whole frame when there is nobody to draw beside it", () => {
        const { stage, faces } = recordingLayout(1, 0);
        expect(stage[0]).toEqual({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
        expect(faces).toEqual([]);
    });

    it("puts two shared screens side by side rather than one over the other", () => {
        const { stage } = recordingLayout(2, 2);
        expect(stage).toHaveLength(2);
        expect(stage[0]?.y).toBe(stage[1]?.y);
        expect(stage[0]?.width).toBe(WIDTH / 2);
    });
});
