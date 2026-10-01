"use client";

/**
 * How loud each voice in a call arrives here, compared with the others.
 *
 * "One person is very quiet for everybody" is a report nobody in the call can
 * act on: the person it is about hears themselves fine, and everybody else can
 * only turn them up, each on their own speakers. What makes it something that
 * can be fixed is a number - how far below the rest of the room a voice sits -
 * and the only place that number can be had without asking anybody to send
 * anything is a browser that is already receiving every voice.
 *
 * So each browser measures the voices it plays and its own outgoing one, on the
 * same scale, and only while the call's own speaker detection says that person
 * is talking: a pause, a keyboard or a fan between sentences is not anybody's
 * speaking level. The estimate is slow - several seconds - because a single
 * shout or whisper is not a level either.
 *
 * Two things read it: the person menu, which says how far somebody arrives
 * below or above the others, and the hint that tells the quiet person
 * themselves - see `quietVerdict`.
 */

import { useSyncExternalStore } from "react";

/** Below this an RMS reading is not a voice, whatever the speaker detection
 *  says: the tail of a word, or a comfort-noise frame. dBFS. */
export const VOICE_FLOOR_DB = -62;

/** How long the estimate takes to follow a change, in seconds. */
const ESTIMATE_SECONDS = 5;

/** The longest a single reading counts for: a timer in a background tab runs
 *  once a second at best. */
const MAX_STEP_MS = 1000;

/** How much speech a level needs behind it before it is compared with anything. */
export const ENOUGH_SPEECH_MS = 12_000;

/** How far below the others a voice has to sit, in dB, before its owner is told,
 *  and how far it has to come back before the hint goes. Ten decibels is about
 *  half as loud to an ear: well past the difference between two microphones that
 *  are both fine. */
export const QUIET_GAP_DB = 10;
export const QUIET_CLEAR_DB = 6;

/** Within this, two voices are "about as loud" as each other. */
export const SAME_DB = 5;

export interface Loudness {
    /** The voice's speaking level in dBFS, or null until it has been heard. */
    readonly speechDb: number | null;
    /** How much speech the level is built on. */
    readonly speechMs: number;
}

export const LOUDNESS_START: Loudness = { speechDb: null, speechMs: 0 };

/** One reading, folded in. Only readings taken while the person was talking
 *  are worth passing; anything under the floor is ignored either way. */
export function stepLoudness(state: Loudness, measuredDb: number, elapsedMs: number): Loudness {
    const ms = Math.min(MAX_STEP_MS, Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0));
    if (ms === 0 || !Number.isFinite(measuredDb) || measuredDb < VOICE_FLOOR_DB) return state;
    const weight = 1 - Math.exp(-ms / 1000 / ESTIMATE_SECONDS);
    const speechDb =
        state.speechDb === null
            ? measuredDb
            : state.speechDb + (measuredDb - state.speechDb) * weight;
    return { speechDb, speechMs: state.speechMs + ms };
}

/** A level with enough speech behind it to compare, or null. */
function settled(level: Loudness | undefined): number | null {
    if (!level || level.speechDb === null || level.speechMs < ENOUGH_SPEECH_MS) return null;
    return level.speechDb;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * How many dB `one` sits below the typical voice among `others` - positive is
 * quieter, negative louder - or null while either side has not been heard
 * enough. The median, so one shouting person does not make everybody else look
 * quiet.
 */
export function gapBelow(one: Loudness | undefined, others: readonly Loudness[]): number | null {
    const own = settled(one);
    if (own === null) return null;
    const heard = others.map(settled).filter((value): value is number => value !== null);
    if (heard.length === 0) return null;
    return median(heard) - own;
}

/** Whether to tell somebody they are quiet, with the hysteresis that stops the
 *  hint flickering on a voice that sits right on the line. */
export function quietVerdict(gap: number | null, wasQuiet: boolean): boolean {
    if (gap === null) return wasQuiet;
    return wasQuiet ? gap >= QUIET_CLEAR_DB : gap >= QUIET_GAP_DB;
}

/** How a gap reads in the person menu. */
export function gapWords(gap: number | null): "unknown" | "quieter" | "louder" | "same" {
    if (gap === null) return "unknown";
    if (gap >= SAME_DB) return "quieter";
    if (gap <= -SAME_DB) return "louder";
    return "same";
}

/* The measurements of the call this browser is in. One call at a time, so one
 * map; the probe that writes it clears it when it goes. */

/** Your own outgoing voice, under a key no account or seat id can be. */
export const SELF = "\u0000self";

let levels: ReadonlyMap<string, Loudness> = new Map();
const listeners = new Set<() => void>();

export function setLoudness(next: ReadonlyMap<string, Loudness>): void {
    levels = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const EMPTY: ReadonlyMap<string, Loudness> = new Map();

/** Every voice measured in the call, keyed by the same key the volumes use (the
 *  account, or the seat for a guest), with your own under `SELF`. */
export function useLoudness(): ReadonlyMap<string, Loudness> {
    return useSyncExternalStore(
        subscribe,
        () => levels,
        () => EMPTY
    );
}

/** How far one person arrives below everybody else measured here. */
export function gapFor(all: ReadonlyMap<string, Loudness>, key: string): number | null {
    const others = [...all.entries()].filter(([other]) => other !== key).map(([, level]) => level);
    return gapBelow(all.get(key), others);
}
