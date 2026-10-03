/**
 * The sounds an alarm or a timer rings with, drawn with Web Audio rather than
 * shipped as files: nothing to download before the first ring, and the same
 * sound on every install.
 *
 * Each sound is one short phrase repeated until it is stopped, at the volume
 * the account chose for every Polaris sound - and for at most `RING_LIMIT_MS`,
 * the way a phone's alarm silences itself rather than ring for an hour in an
 * empty room. The dialog stays up after the sound stops.
 */

import { hostUi } from "@polaris/app-host/client";
import type { ClockSound } from "../../lib/clock/model";

const RING_LIMIT_MS = 3 * 60_000;

type Note = {
    readonly at: number;
    readonly frequency: number;
    readonly length: number;
    readonly type: OscillatorType;
};

/** One phrase of each sound, and how long before it repeats, in seconds. */
const PHRASES: Readonly<
    Record<ClockSound, { readonly notes: readonly Note[]; readonly every: number }>
> = {
    chime: {
        notes: [
            { at: 0, frequency: 880, length: 0.35, type: "sine" },
            { at: 0.35, frequency: 659.25, length: 0.55, type: "sine" }
        ],
        every: 1.6
    },
    bell: {
        notes: [
            { at: 0, frequency: 523.25, length: 1.2, type: "triangle" },
            { at: 0, frequency: 1046.5, length: 0.8, type: "sine" }
        ],
        every: 1.8
    },
    beep: {
        notes: [0, 0.25, 0.5].map((at) => ({
            at,
            frequency: 1000,
            length: 0.12,
            type: "square" as const
        })),
        every: 1.4
    },
    digital: {
        notes: [0, 0.14, 0.28, 0.42].map((at) => ({
            at,
            frequency: 2048,
            length: 0.07,
            type: "square" as const
        })),
        every: 1
    },
    gentle: {
        notes: [
            { at: 0, frequency: 392, length: 0.9, type: "sine" },
            { at: 0.6, frequency: 523.25, length: 1.1, type: "sine" }
        ],
        every: 2.6
    }
};

let context: AudioContext | null = null;

function audio(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Context =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    context ??= new Context();
    // A context made before any click starts suspended; a ring after one has been
    // allowed resumes it.
    void context.resume().catch(() => undefined);
    return context;
}

function play(
    ctx: AudioContext,
    phrase: (typeof PHRASES)[ClockSound],
    start: number,
    loudness: number
): void {
    for (const note of phrase.notes) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = note.type;
        oscillator.frequency.value = note.frequency;
        const begin = start + note.at;
        const level = note.type === "square" ? loudness * 0.12 : loudness * 0.35;
        gain.gain.setValueAtTime(0.0001, begin);
        gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), begin + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, begin + note.length);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(begin);
        oscillator.stop(begin + note.length + 0.05);
    }
}

/** Ring until the returned function is called (or the limit passes). */
export function ring(sound: ClockSound): () => void {
    const ctx = audio();
    const loudness = hostUi.notificationSound.soundGain();
    if (!ctx || loudness <= 0) return () => undefined;
    const phrase = PHRASES[sound];
    let stopped = false;
    const once = () => {
        if (!stopped) play(ctx, phrase, ctx.currentTime + 0.05, loudness);
    };
    once();
    const repeat = window.setInterval(once, phrase.every * 1000);
    const limit = window.setTimeout(() => stop(), RING_LIMIT_MS);
    function stop(): void {
        stopped = true;
        window.clearInterval(repeat);
        window.clearTimeout(limit);
    }
    return stop;
}

/** One phrase of a sound, for choosing it. */
export function preview(sound: ClockSound): void {
    const ctx = audio();
    const loudness = hostUi.notificationSound.soundGain();
    if (ctx && loudness > 0) play(ctx, PHRASES[sound], ctx.currentTime + 0.05, loudness);
}
