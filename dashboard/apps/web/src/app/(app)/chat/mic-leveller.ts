/**
 * Putting a voice back at a speaking level after the noise model has run.
 *
 * The model is trained to keep speech and remove everything else, and on a
 * microphone that hears the voice well that is all it does. On one that hears it
 * badly - a laptop lid across a desk, a headset whose level is low in the
 * operating system - the voice is close to the noise floor, and the model takes
 * a good part of the voice away with the floor. The browser's own gain control
 * cannot put it back: it runs before the model, on a signal that still had the
 * room in it, so it judged the level by a room that is no longer there.
 *
 * A fixed makeup gain was the first answer, and it is right for an average
 * microphone and wrong for exactly the one somebody complains about: four
 * decibels back on a voice that lost twelve is still a person everybody has to
 * strain to hear. So the level is measured where it actually is - after the
 * model - and brought towards a speaking level, slowly, within limits:
 *
 * - **Only speech moves it.** Below `SPEECH_FLOOR_DB` the model has left nothing
 *   but the residue of a room, and lifting that is lifting noise, so the gain is
 *   held where it was through every pause.
 * - **The estimate is slow, the gain follows it.** What is chased is the level of
 *   the voice over the last second or two, never one syllable - a gain that
 *   chases syllables is the pumping everybody recognises as a bad call.
 * - **Bounded both ways.** Never below the level the model left (making somebody
 *   quieter is the volume setting's job, not this one's) and never more than
 *   `MAX_GAIN_DB` above it, because past that a voice is mostly amplified room.
 *   The limiter after it catches any peak this pushes over.
 *
 * Pure on purpose: it is a few lines of arithmetic, and the graph that applies it
 * is a GainNode moved by a timer - see `filterMic`.
 */

/** Where a voice is brought to, as the RMS of what leaves the model, in dBFS. An
 *  ordinary voice at an ordinary distance from a decent microphone reads about
 *  here once the browser's gain control has had it. */
export const TARGET_DB = -24;

/** Below this, what comes out of the model is a pause, not a voice. */
export const SPEECH_FLOOR_DB = -58;

/** The gain a voice starts with before anything has been heard: the makeup the
 *  fixed stage used to apply, so nobody sounds different in the first seconds
 *  from how they did before this existed. */
export const START_GAIN_DB = 4;

/** Never below what the model left, never more than this above it. */
export const MIN_GAIN_DB = 0;
export const MAX_GAIN_DB = 15;

/** How quickly the estimate of the voice follows what is heard. Seconds. */
const ESTIMATE_SECONDS = 1.5;

/** How fast the gain itself may move, in decibels a second. Down faster than up:
 *  somebody who leans in and gets loud should not have to shout through a gain
 *  that is still catching up. */
const RISE_DB_PER_S = 3;
const FALL_DB_PER_S = 8;

/** One reading's worth of time at most. A background tab's timer runs once a
 *  second or slower, and a gap of a minute is not a minute of evidence. */
const MAX_STEP_MS = 1000;

export interface LevellerState {
    /** The level of the voice, in dBFS before this stage, or null until a voice
     *  has been heard. */
    readonly speechDb: number | null;
    /** The gain being applied, in dB. */
    readonly gainDb: number;
}

export const LEVELLER_START: LevellerState = { speechDb: null, gainDb: START_GAIN_DB };

/** Root-mean-square of a block of samples, in dBFS. Silence is -Infinity. */
export function rmsDb(samples: ArrayLike<number>): number {
    if (samples.length === 0) return Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index] ?? 0;
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples.length);
    return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

export function dbToGain(db: number): number {
    return 10 ** (db / 20);
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

/**
 * One reading, folded into the state.
 *
 * @param measuredDb - The RMS of what came out of the model over the last block,
 *   before this stage's gain. Measured there rather than after, so the gain is
 *   never chasing its own output.
 * @param elapsedMs - Time since the previous reading.
 */
export function stepLeveller(
    state: LevellerState,
    measuredDb: number,
    elapsedMs: number
): LevellerState {
    const dt = clamp(Number.isFinite(elapsedMs) ? elapsedMs : 0, 0, MAX_STEP_MS) / 1000;
    if (dt === 0) return state;

    // A pause: nothing to learn from, and nothing to lift.
    if (!Number.isFinite(measuredDb) || measuredDb < SPEECH_FLOOR_DB) return state;

    const weight = 1 - Math.exp(-dt / ESTIMATE_SECONDS);
    const speechDb =
        state.speechDb === null
            ? measuredDb
            : state.speechDb + (measuredDb - state.speechDb) * weight;

    const wanted = settledGainDb(speechDb);
    const change = wanted - state.gainDb;
    const limit = (change > 0 ? RISE_DB_PER_S : FALL_DB_PER_S) * dt;
    return { speechDb, gainDb: state.gainDb + clamp(change, -limit, limit) };
}

/** The gain a voice held at `speechDb` settles on: nothing for a voice already at
 *  the target, the difference for a quiet one, capped. */
export function settledGainDb(speechDb: number): number {
    return clamp(TARGET_DB - speechDb, MIN_GAIN_DB, MAX_GAIN_DB);
}
