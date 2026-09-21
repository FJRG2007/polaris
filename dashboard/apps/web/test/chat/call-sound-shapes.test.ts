/**
 * Whether the call sounds can be told apart.
 *
 * The defect this pins down: a screen going up, a screen coming down, somebody
 * arriving, somebody leaving and somebody hanging up were all the same gesture -
 * two notes on a sine wave, one rising or falling fifth, a tone or two apart from
 * each other. An interval is not something anybody names off a laptop speaker, so
 * a screen coming down sounded like somebody hanging up and a screen going up
 * sounded like somebody joining.
 *
 * What is held here is the rule rather than the notes: a sound that means one
 * thing must differ from a sound that means another in its shape - the number of
 * notes, or what they are made of - and not only in which note it starts on.
 * Pitches stay tunable, because nobody promised a particular one.
 */

import { describe, expect, it } from "vitest";
import { SOUNDS, type CallSound } from "@/lib/call-sounds";

/** What a sound is, at the resolution an ear has: how many notes, whether it
 *  goes up or down, and what it is made of. */
function shape(name: CallSound) {
    const notes = SOUNDS[name];
    const first = notes[0]!;
    const last = notes[notes.length - 1]!;
    return {
        notes: notes.length,
        way: last.from > first.from ? "up" : last.from < first.from ? "down" : "flat",
        wave: first.wave ?? "sine"
    };
}

/** The events of a call that are announced by a sound, and nothing else: a ring
 *  is not one of these and neither is a message in another conversation. */
const EVENTS: readonly CallSound[] = ["join", "leave", "shareOn", "shareOff", "hangUp"];

describe("a screen going up or coming down", () => {
    it("is made of a different wave from every other thing that happens", () => {
        for (const other of ["join", "leave", "hangUp"] as const) {
            expect(shape("shareOn").wave).not.toBe(shape(other).wave);
            expect(shape("shareOff").wave).not.toBe(shape(other).wave);
        }
    });

    it("goes up for a screen and down for one that came down", () => {
        // The one thing the two share, and the only thing that separates them:
        // the same figure, reversed, which is how every client draws this pair.
        expect(shape("shareOn").way).toBe("up");
        expect(shape("shareOff").way).toBe("down");
        expect(shape("shareOn").notes).toBe(shape("shareOff").notes);
        expect(shape("shareOn").wave).toBe(shape("shareOff").wave);
    });
});

describe("every pair of announced events", () => {
    it("differs in something other than pitch", () => {
        const pairs = EVENTS.flatMap((one, index) =>
            EVENTS.slice(index + 1).map((other) => [one, other] as const)
        );
        for (const [one, other] of pairs) {
            const a = shape(one);
            const b = shape(other);
            // Arriving and leaving are the same notes reversed on purpose, and so
            // are the two share sounds: opposite directions are a difference an
            // ear hears. Anything else has to differ in its count or its wave.
            const told = a.way !== b.way || a.notes !== b.notes || a.wave !== b.wave;
            expect(told, `${one} and ${other} sound alike`).toBe(true);
        }
    });

    it("never plays a single note, which is a beep with no direction in it", () => {
        for (const name of EVENTS) expect(SOUNDS[name].length).toBeGreaterThan(1);
    });

    it("keeps the call ending apart from somebody stepping out of it", () => {
        // Both fall, because both are a thing ending. What separates them is the
        // length of the fall - one note more, and the last of them held - because
        // a fifth of pitch between them was not something anybody could hear.
        expect(shape("hangUp").notes).not.toBe(shape("leave").notes);
    });
});
