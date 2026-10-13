/**
 * What a shared screen is arriving at, as its tile says it: "720P 30FPS".
 *
 * Read off the frames the browser painted rather than what the sender chose, so
 * a share thinned on the way says what actually arrived.
 */

import { describe, expect, it } from "vitest";
import { streamFormat } from "@/app/(app)/chat/call-stream-format";

describe("a shared screen's format", () => {
    it("is the picture's height and the frames painted per second", () => {
        expect(streamFormat(720, 100, 130, 1)).toEqual({ height: 720, fps: 30 });
        expect(streamFormat(1080, 0, 119, 2)).toEqual({ height: 1080, fps: 60 });
    });

    it("says nothing before there is a picture and two readings", () => {
        expect(streamFormat(0, 0, 30, 1)).toBeNull();
        expect(streamFormat(720, null, 30, 1)).toBeNull();
        expect(streamFormat(720, 0, null, 1)).toBeNull();
        expect(streamFormat(720, 0, 30, 0)).toBeNull();
    });

    it("never goes below zero when the count starts again", () => {
        expect(streamFormat(720, 500, 10, 1)).toEqual({ height: 720, fps: 0 });
    });
});
