/**
 * What a shared screen is arriving at, as its tile says it: "720P 30FPS".
 *
 * Read off the frames the browser painted rather than what the sender chose, so
 * a share thinned on the way says what actually arrived.
 */

import { describe, expect, it } from "vitest";
import { NO_RATE, standardRate, steadyRate, streamFormat } from "@/app/(app)/chat/call-stream-format";

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

describe("the rate a shared screen's tile says", () => {
    const fold = (readings: number[]) =>
        readings.reduce((state, fps) => steadyRate(state, fps), NO_RATE).shown;

    it("is a standard one, not the measured count", () => {
        expect(standardRate(29)).toBe(30);
        expect(standardRate(58)).toBe(60);
        expect(standardRate(23)).toBe(24);
        expect(fold([29, 31, 28])).toBe(30);
    });

    it("stays put while nothing on the screen moves", () => {
        expect(fold([60, 1, 0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBe(60);
    });

    it("says no rate at all until something has moved", () => {
        expect(fold([1, 2, 0])).toBeNull();
    });

    it("comes down only once moving frames keep arriving slower", () => {
        expect(fold([60, 30, 30, 30])).toBe(60);
        expect(fold([60, ...Array<number>(10).fill(30)])).toBe(30);
    });
});
