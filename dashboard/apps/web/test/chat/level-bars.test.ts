/**
 * A microphone's level as a row of bars.
 *
 * What is pinned: a quiet room lights nothing, the row fills with the level and
 * never past its end, and the colours run green, yellow, red from left to right
 * whatever the reading - so red is only ever reached by being loud.
 */

import { describe, expect, it } from "vitest";
import { METER_BARS, barTone, litBars } from "@/app/(app)/chat/level-bars";

describe("how many bars a level lights", () => {
    it("lights nothing for silence or the noise of a quiet room", () => {
        expect(litBars(0)).toBe(0);
        expect(litBars(2)).toBe(0);
        expect(litBars(Number.NaN)).toBe(0);
    });

    it("grows with the level", () => {
        const readings = [5, 20, 40, 60, 80, 100].map((level) => litBars(level));
        for (let index = 1; index < readings.length; index++) {
            expect(readings[index]!).toBeGreaterThan(readings[index - 1]!);
        }
    });

    it("fills the row at full scale and never past it", () => {
        expect(litBars(100)).toBe(METER_BARS);
        expect(litBars(250)).toBe(METER_BARS);
    });
});

describe("the colour of each bar", () => {
    it("runs green, then yellow, then red", () => {
        const tones = Array.from({ length: METER_BARS }, (_, index) => barTone(index));
        expect(tones[0]).toBe("low");
        expect(tones.at(-1)).toBe("high");
        expect(tones).toContain("mid");
        // Never back down the scale going right.
        const order = { low: 0, mid: 1, high: 2 } as const;
        for (let index = 1; index < tones.length; index++) {
            expect(order[tones[index]!]).toBeGreaterThanOrEqual(order[tones[index - 1]!]);
        }
    });

    it("keeps an ordinary voice in the green", () => {
        const lit = litBars(30);
        for (let index = 0; index < lit; index++) expect(barTone(index)).toBe("low");
    });

    it("reaches the red only when loud", () => {
        const lit = litBars(100);
        expect(barTone(lit - 1)).toBe("high");
    });
});
