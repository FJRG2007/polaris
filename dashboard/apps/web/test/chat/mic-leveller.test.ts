/**
 * The level a voice is put back at after the noise model.
 *
 * Reported as one person in a call being "very quiet for everybody": the model
 * takes part of a voice away along with the room, most of all on a microphone
 * that hears the voice badly, and a fixed four decibels back is not enough for
 * exactly that microphone. What is pinned: a quiet voice is brought up towards a
 * speaking level, within a cap; a voice already there is left alone; pauses do
 * not move it; and it moves slowly enough not to pump.
 */

import { describe, expect, it } from "vitest";
import {
    dbToGain,
    LEVELLER_START,
    MAX_GAIN_DB,
    MIN_GAIN_DB,
    rmsDb,
    settledGainDb,
    START_GAIN_DB,
    stepLeveller,
    TARGET_DB,
    type LevellerState
} from "@/app/(app)/chat/mic-leveller";

/** Feed one level for a while, at the rate the graph reads it. */
function run(state: LevellerState, db: number, ms: number, every = 100): LevellerState {
    let current = state;
    for (let at = 0; at < ms; at += every) current = stepLeveller(current, db, every);
    return current;
}

describe("the measurement", () => {
    it("reads a full-scale square wave as 0 dBFS and silence as nothing", () => {
        expect(rmsDb([1, -1, 1, -1])).toBeCloseTo(0, 6);
        expect(rmsDb([0.1, -0.1])).toBeCloseTo(-20, 6);
        expect(rmsDb(new Float32Array(64))).toBe(Number.NEGATIVE_INFINITY);
        expect(rmsDb([])).toBe(Number.NEGATIVE_INFINITY);
    });

    it("turns decibels into the multiplier a gain node takes", () => {
        expect(dbToGain(0)).toBe(1);
        expect(dbToGain(20)).toBeCloseTo(10, 6);
        expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    });
});

describe("where a voice settles", () => {
    it("starts at the makeup the fixed stage used to apply", () => {
        expect(LEVELLER_START.gainDb).toBe(START_GAIN_DB);
        expect(dbToGain(START_GAIN_DB)).toBeCloseTo(1.6, 1);
    });

    it("brings a quiet voice up by the difference", () => {
        const settled = run(LEVELLER_START, TARGET_DB - 10, 20_000);
        expect(settled.gainDb).toBeCloseTo(10, 1);
        expect(settledGainDb(TARGET_DB - 10)).toBe(10);
    });

    it("stops at the cap for a voice that is barely there", () => {
        expect(run(LEVELLER_START, -55, 30_000).gainDb).toBeCloseTo(MAX_GAIN_DB, 5);
    });

    it("never makes a loud voice quieter than the model left it", () => {
        expect(run(LEVELLER_START, -10, 20_000).gainDb).toBeCloseTo(MIN_GAIN_DB, 5);
    });
});

describe("how it moves", () => {
    it("holds through a pause, whatever the pause measures", () => {
        const talking = run(LEVELLER_START, -36, 10_000);
        expect(run(talking, -80, 10_000)).toEqual(talking);
        expect(run(talking, Number.NEGATIVE_INFINITY, 10_000)).toEqual(talking);
    });

    it("rises no faster than a few dB a second", () => {
        const after = run(LEVELLER_START, -55, 1000);
        expect(after.gainDb - START_GAIN_DB).toBeLessThanOrEqual(3.0001);
        expect(after.gainDb).toBeGreaterThan(START_GAIN_DB);
    });

    it("treats a long gap between readings as one second, not a minute", () => {
        const once = stepLeveller(LEVELLER_START, -55, 60_000);
        expect(once.gainDb - START_GAIN_DB).toBeLessThanOrEqual(3.0001);
    });

    it("follows the voice over seconds, not one loud syllable", () => {
        const talking = run(LEVELLER_START, -34, 15_000);
        const shout = stepLeveller(talking, -6, 100);
        // One block of shouting moves the estimate a little and the gain less.
        expect(talking.gainDb - shout.gainDb).toBeLessThan(1);
    });
});
