/**
 * Hearing the laptop on the other side of the table.
 *
 * The measurement itself needs two machines in one room, which is exactly why
 * the arithmetic is separated from the microphone: what a tone has to clear
 * before it is believed is a rule, and a rule can be checked with a made-up
 * spectrum.
 *
 * The case worth holding down is the second one. A room with a projector, a fan
 * and an air conditioner has plenty of energy up where the tones sit, and a
 * threshold that was a fixed number would find a device in every noisy office.
 * What counts is standing above the room, not being loud.
 */

import { describe, expect, it } from "vitest";
import { binOf, slotHz, slotsHeard, NEARBY_SLOTS } from "@/app/(app)/chat/call-nearby";

const RATE = 48_000;
const FFT = 8192;

/** A quiet room, as a microphone reports one. */
function quiet(): Float32Array {
    return new Float32Array(FFT / 2).fill(-95);
}

/** Somebody else's device, playing its tone across the table. */
function playing(spectrum: Float32Array, slot: number, decibels: number): Float32Array {
    const centre = binOf(slotHz(slot), RATE, FFT);
    for (let bin = centre - 1; bin <= centre + 1; bin += 1) spectrum[bin] = decibels;
    return spectrum;
}

describe("listening for the room", () => {
    it("hears a tone standing over a quiet room", () => {
        expect(slotsHeard(playing(quiet(), 3, -60), RATE, FFT)).toEqual([3]);
    });

    it("hears more than one device at once", () => {
        const spectrum = playing(playing(quiet(), 0, -55), 5, -62);
        expect(slotsHeard(spectrum, RATE, FFT)).toEqual([0, 5]);
    });

    it("hears nothing in a loud room where no tone stands out", () => {
        // Every bin at the same level: a fan, not a device. A fixed threshold
        // would have called this eight devices.
        expect(slotsHeard(new Float32Array(FFT / 2).fill(-50), RATE, FFT)).toEqual([]);
    });

    it("hears nothing at all in silence", () => {
        expect(slotsHeard(quiet(), RATE, FFT)).toEqual([]);
        // Some browsers report silence as -Infinity rather than a number.
        expect(slotsHeard(new Float32Array(FFT / 2).fill(-Infinity), RATE, FFT)).toEqual([]);
    });

    it("gives up rather than guessing when the spectrum does not reach that high", () => {
        // A context that opened at a sample rate too low to represent the tones
        // at all. The band would be off the end of the array.
        expect(slotsHeard(new Float32Array(64).fill(-40), 8_000, 128)).toEqual([]);
    });

    it("keeps the slots far enough apart not to be mistaken for each other", () => {
        for (let slot = 1; slot < NEARBY_SLOTS; slot += 1) {
            const apart = binOf(slotHz(slot), RATE, FFT) - binOf(slotHz(slot - 1), RATE, FFT);
            // Well clear of the two bins either side that a reading is taken
            // over, so one device's tone cannot be counted as its neighbour's.
            expect(apart).toBeGreaterThan(8);
        }
    });
});
