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
    /** Peak volume, 0 to 1. These are notifications and sit well under a voice.
     *  A ring is the exception and says so: it is not played over anything. */
    readonly gain?: number;
    /**
     * Held at full volume until a short release at the end, rather than fading
     * from the moment it starts.
     *
     * A sustained tone is what a machine sounds like: an alarm, a lift, a door
     * held open. Nothing here uses it any more - it was the first attempt at
     * making the ring audible and it worked, in the sense that a smoke detector
     * works. It stays because it is the right envelope for anything that ever
     * needs to be insisted on rather than heard.
     */
    readonly sustain?: boolean;
    /**
     * Rung rather than played: the note, its octave and its twelfth, together.
     *
     * This is what the difference between a tone and a chime actually is. A bare
     * sine has nothing above the fundamental, which is why it reads as
     * electronic however loud it is made; a bell is the same note with a couple
     * of quieter partials over it, all fading together. Three oscillators, a few
     * hundred bytes, and it stops sounding like a fire door.
     *
     * The partials are deliberately not a musician's harmonic series - a real
     * bell is inharmonic and this is not trying to be one. An octave and a
     * twelfth are consonant with anything else sounding at the time, which
     * matters here because the notes of a ring overlap on purpose.
     */
    readonly bell?: boolean;
    /**
     * The shape of the wave.
     *
     * A sine is the default because it has no harmonics to clash with speech,
     * which is the one thing these are played over. A ring is not played over
     * anything - it is played instead of a call - so it can afford the partials
     * `bell` adds, which is a warmer way to be heard than a harder waveform.
     */
    readonly wave?: OscillatorType;
}

export type CallSound =
    | "message"
    | "join"
    | "leave"
    | "shareOn"
    | "shareOff"
    | "hangUp"
    | "ring"
    | "ringBack";

/** How loud the incoming ring is. Several times everything else here, and that
 *  is the point of it: every other sound is played to somebody already looking
 *  at the screen, and this one is played to somebody who is not in the room. A
 *  single oscillator sounds at a time, so nothing here can sum into clipping. */
const RING_GAIN = 0.26;

/**
 * Every sound, as data.
 *
 * Exported so the two things that cannot be heard from the code can be asserted
 * instead: that a ring fits inside the gap before it starts again, and that the
 * one sound meant to carry across a room is actually louder than the ones meant
 * not to. Both were wrong once, silently.
 */
export const SOUNDS: Record<CallSound, readonly Note[]> = {
    /**
     * Somebody said something in a conversation that is not the one on screen.
     *
     * Quieter and shorter than anything else here, because it is the one that
     * happens all day: two notes a fifth apart, gone in a tenth of a second.
     * Loud enough to look up at, quiet enough to sit next to somebody using it.
     */
    message: [
        { from: 659.25, at: 0, seconds: 0.05, gain: 0.05 },
        { from: 987.77, at: 0.045, seconds: 0.07, gain: 0.05 }
    ],
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
    /**
     * One pass of an incoming ring. Repeated by `startRinging`.
     *
     * The shape a telephone has always had: a pair of notes, a breath, the same
     * pair again, then a long silence. Two pulses rather than one because a
     * single one is indistinguishable from any other notification a machine
     * makes - the repeat is what says somebody is waiting on the other end.
     *
     * Loud, sustained and with harmonics in it, which the first version of this
     * was none of. It is the only sound here that has to carry to somebody who
     * is not looking at the screen.
     */
    ring: [
        { from: 440, at: 0, seconds: 1, gain: RING_GAIN, bell: true },
        { from: 554.37, at: 0.16, seconds: 1, gain: RING_GAIN, bell: true },
        { from: 659.25, at: 0.32, seconds: 1.2, gain: RING_GAIN, bell: true },
        { from: 440, at: 1.1, seconds: 1, gain: RING_GAIN, bell: true },
        { from: 554.37, at: 1.26, seconds: 1, gain: RING_GAIN, bell: true },
        { from: 659.25, at: 1.42, seconds: 1.3, gain: RING_GAIN, bell: true }
    ],
    /** What the caller hears while nobody has answered. Held rather than
     *  plucked, like the tone a telephone gives back, and deliberately far
     *  quieter than the ring: this one plays to somebody who is already looking
     *  at the screen and knows what they just pressed. */
    ringBack: [{ from: 440, at: 0, seconds: 1.1, gain: 0.1, bell: true }]
};

/**
 * How often each ring repeats, and the longest either goes on for.
 *
 * One interval per sound rather than one for both, because they are two
 * different lengths: a pass of the incoming ring is nearly two seconds of
 * pattern and a ringback is one held note. A single interval short enough for
 * the second starts the first again over the top of itself, which is how a ring
 * turns into a drone.
 *
 * The give-up is the shape a telephone has always had: somebody who is not there
 * is not going to be there, and a browser tab that rings forever is one people
 * close.
 */
export const RING_EVERY_MS: Record<"ring" | "ringBack", number> = { ring: 3400, ringBack: 3000 };
export const RING_FOR_MS = 45_000;

/** How loud a tone is by default. Low: these play over whatever the reader is
 *  already listening to, and over the call itself. */
export const DEFAULT_GAIN = 0.1;

/** How long a note takes to reach its peak, and to let go of it. Ramped rather
 *  than switched: a square edge on a gain node is an audible click, and a click
 *  on every join is worse than silence. */
const ATTACK_SECONDS = 0.012;
const RELEASE_SECONDS = 0.05;

/** How loud a bell's partials are beside its fundamental. Quiet enough that the
 *  note is still the note somebody hears, present enough that it stops sounding
 *  like a signal generator. Kept low for a second reason: the notes of the ring
 *  overlap, and three bells sounding at once must not add up past full scale. */
const OCTAVE_SHARE = 0.3;
const TWELFTH_SHARE = 0.12;

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
        // One partial, or three of them. `sound` is the whole note: the tone
        // itself is the first call and a bell adds its octave and its twelfth
        // over the top, each quieter and all fading together.
        sound(ctx, note, start, 1, 1);
        if (!note.bell) continue;
        sound(ctx, note, start, 2, OCTAVE_SHARE);
        sound(ctx, note, start, 3, TWELFTH_SHARE);
    }
}

/** One oscillator: the note at some multiple of its frequency, at some share of
 *  its volume, with the note's own envelope. */
function sound(
    ctx: AudioContext,
    note: Note,
    start: number,
    multiple: number,
    share: number
): void {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = note.wave ?? "sine";
    oscillator.frequency.setValueAtTime(note.from * multiple, start + note.at);
    if (note.to !== undefined) {
        oscillator.frequency.linearRampToValueAtTime(
            note.to * multiple,
            start + note.at + note.seconds
        );
    }
    const peak = (note.gain ?? DEFAULT_GAIN) * share;
    const from = start + note.at;
    const to = from + note.seconds;
    gain.gain.setValueAtTime(0.0001, from);
    gain.gain.exponentialRampToValueAtTime(peak, from + ATTACK_SECONDS);
    if (note.sustain) {
        // Held at the peak, then let go over the last few hundredths. Everything
        // else fades across its whole length, which is what a struck thing does
        // and what keeps a ring from sounding like an alarm.
        gain.gain.setValueAtTime(peak, Math.max(from + ATTACK_SECONDS, to - RELEASE_SECONDS));
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, to);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(from);
    oscillator.stop(to + 0.02);
}

/**
 * Ring until the returned function is called, or until it gives up.
 *
 * The first pass is immediate: a ring that waits for its own interval before the
 * first sound is a ring that is missed.
 */
export function startRinging(name: "ring" | "ringBack" = "ring"): () => void {
    playCallSound(name);
    const timer = setInterval(() => playCallSound(name), RING_EVERY_MS[name]);
    const stopAt = setTimeout(() => clearInterval(timer), RING_FOR_MS);
    return () => {
        clearInterval(timer);
        clearTimeout(stopAt);
    };
}
