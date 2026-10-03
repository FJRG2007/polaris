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

    it("never takes a loud voice below the makeup it had before", () => {
        expect(MIN_GAIN_DB).toBe(START_GAIN_DB);
        expect(run(LEVELLER_START, -10, 20_000).gainDb).toBeCloseTo(START_GAIN_DB, 5);
    });
});

/**
 * A voice, not a constant level: syllables of a voiced sound with gaps between
 * them and pauses between phrases, from a fixed seed so every run hears the same
 * one. Close enough to speech for what is measured here, which is how the
 * leveller's 100 ms readings of a 2048-sample window add up over a minute.
 */
function voice(seconds: number, activeDb: number): Float32Array {
    const rate = 48_000;
    const out = new Float32Array(seconds * rate);
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let at = 0;
    let syllables = 0;
    while (at < out.length) {
        const length = Math.floor((0.12 + random() * 0.16) * rate);
        const pitch = 110 + random() * 60;
        const loudness = 0.4 + random() * 0.6;
        for (let index = 0; index < length && at + index < out.length; index += 1) {
            const envelope = Math.sin((Math.PI * index) / length);
            const time = index / rate;
            let sample = 0;
            for (let harmonic = 1; harmonic <= 8; harmonic += 1)
                sample += Math.sin(2 * Math.PI * pitch * harmonic * time) / harmonic;
            out[at + index] = sample * envelope * loudness;
        }
        syllables += 1;
        at += length + Math.floor((syllables % 6 === 0 ? 0.6 : 0.04 + random() * 0.1) * rate);
    }
    const gain = dbToGain(activeDb - activeLevelDb(out));
    for (let index = 0; index < out.length; index += 1) out[index] = (out[index] ?? 0) * gain;
    return out;
}

/** The level of a voice while it is talking: power over 20 ms frames that are
 *  within 40 dB of the loudest one, the way speech levels are quoted. */
function activeLevelDb(samples: Float32Array): number {
    const frame = 960;
    const powers: number[] = [];
    for (let start = 0; start + frame <= samples.length; start += frame) {
        let sum = 0;
        for (let index = start; index < start + frame; index += 1)
            sum += (samples[index] ?? 0) ** 2;
        powers.push(sum / frame);
    }
    const loudest = Math.max(...powers);
    const active = powers.filter((power) => power > loudest * 1e-4);
    return 10 * Math.log10(active.reduce((total, power) => total + power, 0) / active.length);
}

/** Put a voice through the leveller the way `filterMic` does - a reading of the
 *  last 2048 samples every 100 ms, the gain ramped towards each new value - and
 *  answer how loud the last third of it goes out. */
function levelledDb(input: Float32Array): number {
    const every = 4800;
    const smoothing = 1 - Math.exp(-1 / (0.05 * 48_000));
    const out = new Float32Array(input.length);
    let state = LEVELLER_START;
    let gain = dbToGain(state.gainDb);
    for (let index = 0; index < input.length; index += 1) {
        if (index >= 2048 && index % every === 0) {
            state = stepLeveller(state, rmsDb(input.subarray(index - 2048, index)), 100);
        }
        gain += (dbToGain(state.gainDb) - gain) * smoothing;
        out[index] = (input[index] ?? 0) * gain;
    }
    return activeLevelDb(out.subarray(Math.floor((input.length * 2) / 3)));
}

describe("what a voice goes out at, against the fixed makeup it replaced", () => {
    // Reported as everybody in a call sounding quieter after the leveller
    // shipped. With a 0 dB floor these came out 3.8, 3.8 and 1.3 dB below.
    it.each([-14, -18, -22])("leaves an ordinary voice at %i dBFS where it was", (level) => {
        const input = voice(60, level);
        const before = level + START_GAIN_DB;
        expect(levelledDb(input) - before).toBeGreaterThan(-0.5);
        expect(levelledDb(input) - before).toBeLessThan(0.5);
    });

    it.each([
        [-30, 4],
        [-36, 7]
    ])("lifts a quiet voice at %i dBFS by at least %i dB more than before", (level, lift) => {
        const input = voice(60, level);
        expect(levelledDb(input) - (level + START_GAIN_DB)).toBeGreaterThan(lift);
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
