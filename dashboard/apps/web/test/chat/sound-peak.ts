/**
 * What a synthesised sound asks of the speakers, worked out from its notes.
 *
 * Shared by the ring's tests and the seasonal packs', which have to meet the
 * same limits.
 */

import { DEFAULT_GAIN, type Note } from "@/lib/call-sounds";

/** When the last note of a pass falls silent, in seconds. */
export function passLength(notes: readonly Note[]): number {
    return notes.reduce((end, note) => Math.max(end, note.at + note.seconds), 0);
}

/**
 * What the speakers are asked for at once, at its worst.
 *
 * The envelopes `sound()` schedules: an exponential ramp from a floor up to the
 * peak over the attack, then an exponential ramp back to the floor across the
 * note. Every partial of every note sounding at an instant adds to the same
 * output, and whatever the sum passes 1 by is clipped flat - which is what
 * saturation is. Written out here because the only other way to know is to
 * listen to it.
 */
export function peakLevel(notes: readonly Note[]): number {
    const OCTAVE = 0.3;
    const TWELFTH = 0.12;
    const ATTACK = 0.012;
    const FLOOR = 0.0001;

    const gainAt = (peak: number, at: number, seconds: number, t: number): number => {
        if (t < at || t > at + seconds) return 0;
        const top = Math.max(peak, 0.0002);
        if (t <= at + ATTACK) return FLOOR * (top / FLOOR) ** ((t - at) / ATTACK);
        return top * (FLOOR / top) ** ((t - at - ATTACK) / Math.max(seconds - ATTACK, 1e-9));
    };

    const span = passLength(notes);
    let worst = 0;
    for (let step = 0; step <= 4000; step += 1) {
        const t = (span * step) / 4000;
        let sum = 0;
        for (const note of notes) {
            const gain = note.gain ?? DEFAULT_GAIN;
            const shares = note.bell ? [1, OCTAVE, TWELFTH] : [1];
            for (const share of shares) sum += gainAt(gain * share, note.at, note.seconds, t);
        }
        worst = Math.max(worst, sum);
    }
    return worst;
}
