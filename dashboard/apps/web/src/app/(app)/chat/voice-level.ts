"use client";

/**
 * How loud a microphone is, right now.
 *
 * Two things need this and they are the same measurement: the bar on the
 * settings screen that shows somebody their own level while they talk into it,
 * and the gate that decides whether a voice-activity microphone is open. Two
 * copies of it would be two thresholds, and the bar would stop agreeing with the
 * thing it exists to help set.
 *
 * The number is a percentage of full scale rather than decibels, because the
 * only way anybody can set a threshold is against a bar they can see moving. A
 * root-mean-square over the time domain rather than an FFT: it is the loudness
 * of a voice that is wanted, not what is in it.
 *
 * The analyser is fed by a Web Audio graph with no destination, so nothing is
 * played back - a microphone routed to the speakers is feedback, and this runs
 * while somebody is holding the microphone up to their mouth.
 */

/** A running measurement of one track. */
export interface VoiceLevel {
    /** 0 to 100, where 100 is full scale. */
    read: () => number;
    stop: () => void;
}

/**
 * Start measuring a track, or null where this browser has no Web Audio.
 *
 * The context is this measurement's own and is closed with it: sharing one with
 * the call's playback would mean a settings screen could suspend the room.
 */
export function measureVoice(track: MediaStreamTrack): VoiceLevel | null {
    const Context =
        typeof window === "undefined"
            ? undefined
            : (window.AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Context) return null;

    let context: AudioContext;
    try {
        context = new Context();
    } catch {
        return null;
    }
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    // Small enough to follow a syllable, large enough that the number does not
    // flicker on every frame.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    let stopped = false;

    return {
        read: () => {
            if (stopped) return 0;
            analyser.getFloatTimeDomainData(samples);
            let sum = 0;
            for (const sample of samples) sum += sample * sample;
            const rms = Math.sqrt(sum / samples.length);
            // A voice sits low on a linear scale, so the reading is stretched to
            // something a bar can show. Squared-root rather than a decibel curve
            // because it has to line up with a slider somebody drags.
            return Math.min(100, Math.round(Math.sqrt(rms) * 140));
        },
        stop: () => {
            if (stopped) return;
            stopped = true;
            try {
                source.disconnect();
            } catch {
                // Already gone with the context.
            }
            void context.close().catch(() => undefined);
        }
    };
}

/**
 * Whether a level counts as somebody speaking, with the hysteresis that keeps a
 * gate from chattering.
 *
 * Opening and closing on the same number is what makes a voice-activity
 * microphone flicker on every pause between words: a level sitting on the
 * threshold crosses it several times a second. It opens at the threshold and
 * closes a good way below it, which is what every gate does and what makes one
 * usable.
 */
export function speaking(level: number, threshold: number, wasOpen: boolean): boolean {
    if (wasOpen) return level > Math.max(0, threshold * 0.6);
    return level >= threshold;
}
