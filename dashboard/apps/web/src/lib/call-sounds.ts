/**
 * What a call sounds like.
 *
 * Every tone is synthesised in the browser rather than fetched. That is not
 * cleverness for its own sake: a self-hosted Polaris must not need the network
 * to tell somebody their phone is ringing, an audio file is a request that can
 * be blocked, cached wrong or 404 after a deploy, and half a dozen of them is
 * half a megabyte shipped to every reader for a sound most of them never hear.
 * Two oscillators and a gain envelope is a few hundred bytes and never fails.
 *
 * The sounds are deliberately plain - a two-note rise for arriving, the same two
 * notes falling for leaving, a repeating pair for a ring. They are signals, not
 * a theme, and a control plane somebody sits in front of all day is the wrong
 * place to be characterful about it.
 *
 * **Nothing plays until the reader has interacted with the page**, because no
 * browser will allow it and trying is how a console fills with errors. An
 * AudioContext created before that lands in `suspended`, so the context is made
 * on first use and resumed each time; a ring that cannot start returns a stop
 * function anyway, so no caller has to care.
 */

/** One note: where it starts, where it ends, and how long it takes. */
interface Note {
    /** Hertz. */
    readonly from: number;
    readonly to?: number;
    /** Seconds from the start of the sound. */
    readonly at: number;
    readonly seconds: number;
    /** Peak volume, 0 to 1. These are notifications and sit well under a voice. */
    readonly gain?: number;
}

export type CallSound =
    | "join"
    | "leave"
    | "shareOn"
    | "shareOff"
    | "hangUp"
    | "ring"
    | "ringBack";

const SOUNDS: Record<CallSound, readonly Note[]> = {
    /** Somebody joined the call you are in. */
    join: [
        { from: 523.25, at: 0, seconds: 0.09 },
        { from: 783.99, at: 0.08, seconds: 0.12 }
    ],
    /** Somebody left it. The same two notes, the other way round. */
    leave: [
        { from: 783.99, at: 0, seconds: 0.09 },
        { from: 523.25, at: 0.08, seconds: 0.14 }
    ],
    /** A screen went up. */
    shareOn: [
        { from: 587.33, at: 0, seconds: 0.07 },
        { from: 880.0, at: 0.06, seconds: 0.1 }
    ],
    /** A screen came down. */
    shareOff: [
        { from: 880.0, at: 0, seconds: 0.07 },
        { from: 587.33, at: 0.06, seconds: 0.1 }
    ],
    /** You hung up, or the call ended under you. */
    hangUp: [
        { from: 466.16, at: 0, seconds: 0.11 },
        { from: 349.23, at: 0.1, seconds: 0.22 }
    ],
    /** One pass of an incoming ring. Repeated by `startRinging`. */
    ring: [
        { from: 659.25, at: 0, seconds: 0.22, gain: 0.16 },
        { from: 523.25, at: 0.26, seconds: 0.26, gain: 0.16 }
    ],
    /** What the caller hears while nobody has answered. */
    ringBack: [{ from: 440, at: 0, seconds: 0.4, gain: 0.07 }]
};

/** How often an unanswered ring repeats, and the longest it goes on for. Both
 *  the shape a telephone has always had: somebody who is not there is not going
 *  to be there, and a browser tab that rings forever is one people close. */
const RING_EVERY_MS = 2400;
export const RING_FOR_MS = 45_000;

/** How loud a tone is by default. Low: these play over whatever the reader is
 *  already listening to, and over the call itself. */
const DEFAULT_GAIN = 0.1;

let context: AudioContext | null = null;

/** The one audio context, made the first time something is played. */
function audio(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    // Suspended is the ordinary state for a context made before the reader
    // pressed anything. Resuming is refused rather than throwing, and the next
    // sound tries again.
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    return context;
}

/** Play one sound, once. Does nothing at all where audio is not available. */
export function playCallSound(name: CallSound): void {
    const ctx = audio();
    if (!ctx) return;
    const start = ctx.currentTime;
    for (const note of SOUNDS[name]) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        // A sine has no harmonics to clash with speech, which is the one thing
        // these will always be played over.
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.from, start + note.at);
        if (note.to !== undefined) {
            oscillator.frequency.linearRampToValueAtTime(note.to, start + note.at + note.seconds);
        }
        // Ramped in and out rather than switched: a square edge on a gain node
        // is an audible click, and a click on every join is worse than silence.
        const peak = note.gain ?? DEFAULT_GAIN;
        gain.gain.setValueAtTime(0.0001, start + note.at);
        gain.gain.exponentialRampToValueAtTime(peak, start + note.at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.seconds);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(start + note.at);
        oscillator.stop(start + note.at + note.seconds + 0.02);
    }
}

/**
 * Ring until the returned function is called, or until it gives up.
 *
 * The first pass is immediate: a ring that waits for its own interval before the
 * first sound is a ring that is missed.
 */
export function startRinging(name: "ring" | "ringBack" = "ring"): () => void {
    playCallSound(name);
    const timer = setInterval(() => playCallSound(name), RING_EVERY_MS);
    const stopAt = setTimeout(() => clearInterval(timer), RING_FOR_MS);
    return () => {
        clearInterval(timer);
        clearTimeout(stopAt);
    };
}
