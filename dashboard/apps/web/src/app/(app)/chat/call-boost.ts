"use client";

/**
 * Playing somebody louder than they were sent.
 *
 * An `<audio>` element's volume stops at 1: it can only ever play a stream
 * quieter than it arrived, which is fine for the person who is too loud and no
 * help at all for the one nobody can hear. Turning them up has to happen in Web
 * Audio, where gain is a number rather than a fraction.
 *
 * The chain is short and each link is there for a reason:
 *
 *   stream -> gain -> limiter -> speakers
 *
 * **The gain** is the setting, applied straight. **The limiter** is what makes
 * the setting usable: doubling a signal that was already near full scale clips
 * it, and clipping is the crunch people describe as "louder but horrible". A
 * compressor with a hard ratio just under full scale catches those peaks and
 * leaves everything below them exactly as it was, so a boosted voice is louder
 * rather than distorted. It costs nothing on the quiet passages, which is most
 * of a call.
 *
 * **The element stays.** Two reasons, and both are the sort that are only
 * learned the hard way. A WebRTC stream is not processed by Web Audio in Chrome
 * unless it is also attached to a media element - the graph runs and produces
 * silence otherwise - so the element is what keeps the stream alive. And the
 * element is what the browser's autoplay policy talks to: the press that starts
 * a refused element is the press that resumes this context.
 *
 * So the element plays anything up to 1 by itself, and the graph is only built
 * for somebody who has been turned up past it. Nobody pays for a feature they
 * have not used: a call where nobody is boosted opens no context at all.
 */

/** One shared context for the whole page. Building one per person is an audio
 *  thread each, and browsers cap how many a page may hold. */
let shared: AudioContext | null = null;

function context(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!shared || shared.state === "closed") shared = new Ctor();
    return shared;
}

/** Let the sound through, for a context the browser started suspended. Called
 *  from the same press that starts a refused element. */
export function resumeBoost(): void {
    void shared?.resume().catch(() => undefined);
}

/** The graph for one person, while they are turned up. */
export interface Boost {
    /** Change how loud they are without rebuilding anything. */
    readonly set: (volume: number) => void;
    readonly stop: () => void;
}

/**
 * Play `stream` through a gain the caller controls.
 *
 * Answers null where Web Audio is unavailable, which leaves the element's own
 * volume in charge - the reader loses the boost and keeps the call.
 */
export function boostStream(stream: MediaStream, volume: number): Boost | null {
    const audio = context();
    if (!audio) return null;

    let source: MediaStreamAudioSourceNode;
    try {
        source = audio.createMediaStreamSource(stream);
    } catch {
        // A stream with no audio track in it yet. The caller rebuilds when the
        // tracks settle.
        return null;
    }

    const gain = audio.createGain();
    gain.gain.value = Math.max(0, volume);

    const limiter = audio.createDynamicsCompressor();
    // Just under full scale, so it is only ever the peaks that are touched.
    limiter.threshold.value = -2;
    // A hard corner and a hard ratio: this is a limiter standing in for one, not
    // a compressor shaping anything.
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    // Fast enough to catch a consonant, slow enough not to breathe on speech.
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(audio.destination);
    // A context that was created outside a gesture starts suspended, and a
    // suspended context is silence.
    void audio.resume().catch(() => undefined);

    return {
        set: (next: number) => {
            const level = Math.max(0, next);
            // Ramped rather than assigned: a step change in gain is an audible
            // click, and this is dragged rather than typed.
            try {
                gain.gain.setTargetAtTime(level, audio.currentTime, 0.02);
            } catch {
                gain.gain.value = level;
            }
        },
        stop: () => {
            source.disconnect();
            gain.disconnect();
            limiter.disconnect();
        }
    };
}
