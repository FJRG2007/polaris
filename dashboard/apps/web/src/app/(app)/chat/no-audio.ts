/**
 * Deciding that a microphone is dead rather than that somebody is quiet.
 *
 * The warning used to fire on anything under a low level for 45 seconds, and a
 * person listening in a quiet room with noise removal on reads exactly that - so
 * it accused people who were simply not talking. What is counted now is only
 * what a working microphone never produces:
 *
 * - **Digital silence from the device.** Every sample exactly zero, for a long
 *   stretch. A real microphone in a silent room still carries a noise floor a
 *   step or two above zero; a device muted in the operating system, switched
 *   off at the cable or taken by another application delivers zeros.
 * - **A voice going in and nothing coming out.** The device hears somebody and
 *   the track being sent stays flat - the noise filter has stopped producing.
 *
 * Only while the microphone is actually sending: push to talk and voice
 * activity close the track between sentences, and a closed track is zeros too.
 *
 * Once shown, the next warning needs twice as long, and closing it keeps it
 * away for the rest of that microphone.
 */

/** Below one step of a 16-bit sample: the device is producing nothing. */
export const FLAT_PEAK = 1 / 32768;
/** Loud enough to be somebody talking into the device (about -40 dBFS). */
export const VOICE_PEAK = 0.01;
/** How long the device has to be flat before it is worth saying. */
export const DEAD_MS = 60_000;
/** How long a voice has to go in with nothing coming out. */
export const SWALLOWED_MS = 15_000;
/** Loud samples with flat output needed before the filter is blamed. */
const SWALLOWED_HITS = 3;

export interface NoAudioWatch {
    /** Since when the device has read flat, or null. */
    readonly flatSince: number | null;
    /** Since when voice has gone in with nothing sent, or null. */
    readonly swallowedSince: number | null;
    readonly swallowedHits: number;
    /** How many times the warning has been shown for this microphone. */
    readonly shown: number;
    readonly warning: boolean;
    readonly dismissed: boolean;
}

export const NO_AUDIO_START: NoAudioWatch = {
    flatSince: null,
    swallowedSince: null,
    swallowedHits: 0,
    shown: 0,
    warning: false,
    dismissed: false
};

export interface NoAudioSample {
    readonly now: number;
    /** Whether the microphone is open right now - on, and not held closed by a
     *  gate. */
    readonly sending: boolean;
    /** The device's loudest sample, 0 to 1. */
    readonly device: number;
    /** The loudest sample of what is being sent, 0 to 1. */
    readonly outgoing: number;
}

/** One reading, folded into what is known. */
export function watchNoAudio(state: NoAudioWatch, sample: NoAudioSample): NoAudioWatch {
    if (!sample.sending) {
        return {
            ...state,
            flatSince: null,
            swallowedSince: null,
            swallowedHits: 0,
            warning: false
        };
    }
    const { now } = sample;
    const flat = sample.device < FLAT_PEAK;
    const flatSince = flat ? (state.flatSince ?? now) : null;

    let swallowedSince = state.swallowedSince;
    let swallowedHits = state.swallowedHits;
    if (sample.outgoing >= FLAT_PEAK) {
        swallowedSince = null;
        swallowedHits = 0;
    } else if (sample.device >= VOICE_PEAK) {
        swallowedSince = swallowedSince ?? now;
        swallowedHits += 1;
    }

    // The window a warning already on screen appeared with, so it does not
    // vanish the moment it is counted.
    const backoff = 2 ** (state.warning ? state.shown - 1 : state.shown);
    const dead = flatSince !== null && now - flatSince >= DEAD_MS * backoff;
    const swallowed =
        swallowedSince !== null &&
        swallowedHits >= SWALLOWED_HITS &&
        now - swallowedSince >= SWALLOWED_MS * backoff;
    const warning = !state.dismissed && (dead || swallowed);

    return {
        flatSince,
        swallowedSince,
        swallowedHits,
        // Counted when it appears, so a warning that clears and comes back
        // waits longer each time.
        shown: warning && !state.warning ? state.shown + 1 : state.shown,
        warning,
        dismissed: state.dismissed
    };
}

/** Closed by the person: not shown again for this microphone. */
export function dismissNoAudio(state: NoAudioWatch): NoAudioWatch {
    return { ...state, warning: false, dismissed: true };
}
