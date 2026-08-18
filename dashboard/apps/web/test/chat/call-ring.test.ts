/**
 * The sound a call makes when it wants you.
 *
 * The ring was reported as practically inaudible, and it was, for two reasons
 * neither of which is visible in the code that plays it.
 *
 * Every note faded from the instant it started - a peak, then an exponential
 * slide to nothing across the whole of its length - so a note written as a fifth
 * of a second had spent most of that near silence. That is right for the blip a
 * message makes forty times a day. It is wrong for the one sound whose entire
 * job is to be noticed by somebody in another room, and the two were sharing an
 * envelope.
 *
 * And it was a bare sine at a sixth of full scale. A sine is the quietest thing
 * an oscillator can produce at a given height, because the ear reads harmonics
 * as loudness.
 *
 * So what is asserted here is what a person would otherwise have to be in the
 * room to notice: that a ring is louder than the things meant not to interrupt,
 * that it holds rather than fades, and that a pass finishes before the next one
 * begins - a pattern longer than its own gap does not ring, it drones.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_GAIN, RING_EVERY_MS, SOUNDS } from "@/lib/call-sounds";

/** When the last note of a pass falls silent, in seconds. */
function passSeconds(name: keyof typeof SOUNDS): number {
    return SOUNDS[name].reduce((end, note) => Math.max(end, note.at + note.seconds), 0);
}

describe("the incoming ring", () => {
    it("is louder than the sounds that are not meant to interrupt", () => {
        for (const note of SOUNDS.ring) {
            expect(note.gain ?? DEFAULT_GAIN).toBeGreaterThan(DEFAULT_GAIN * 2);
        }
    });

    it("holds each note instead of fading from the moment it starts", () => {
        // This is the whole of the original complaint. Without it the ring is
        // four blips, whatever volume they are written at.
        for (const note of SOUNDS.ring) expect(note.sustain).toBe(true);
    });

    it("rings twice per pass, the way a telephone does", () => {
        // One pulse is indistinguishable from any other noise a machine makes.
        // The repeat is what says somebody is on the other end waiting.
        expect(SOUNDS.ring.length).toBeGreaterThanOrEqual(4);
    });

    it("finishes before it starts again", () => {
        // A pass longer than its own gap overlaps itself, and a ring that
        // overlaps itself is a drone.
        expect(passSeconds("ring")).toBeLessThan(RING_EVERY_MS.ring / 1000);
    });
});

describe("the tone the caller hears", () => {
    it("stays well under the ring", () => {
        // It plays to somebody already looking at the screen, who knows what
        // they just pressed. The other one plays to somebody who is not there.
        const back = SOUNDS.ringBack[0]?.gain ?? DEFAULT_GAIN;
        const ring = SOUNDS.ring[0]?.gain ?? DEFAULT_GAIN;
        expect(back).toBeLessThan(ring);
    });

    it("is held rather than plucked, like a telephone's", () => {
        expect(SOUNDS.ringBack.every((note) => note.sustain)).toBe(true);
    });

    it("finishes before it starts again", () => {
        expect(passSeconds("ringBack")).toBeLessThan(RING_EVERY_MS.ringBack / 1000);
    });
});

describe("everything else", () => {
    it("stays quiet enough to sit next to somebody using it", () => {
        // The ring is the exception, and it has to stay the exception: a join
        // chime at ringing volume in a call of eight is unusable.
        for (const name of ["message", "join", "leave", "shareOn", "shareOff", "hangUp"] as const) {
            for (const note of SOUNDS[name]) {
                expect(note.gain ?? DEFAULT_GAIN).toBeLessThanOrEqual(DEFAULT_GAIN);
            }
        }
    });
});
