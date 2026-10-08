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
 * Plain, though, is not the same as interchangeable. **Two sounds that mean
 * different things have to differ in shape** - in how many notes there are, how
 * fast they come and what they are made of - because pitch alone is not something
 * anybody can hear the difference in. Four of these were the same two-note
 * gesture a tone or two apart, so a screen coming down was heard as somebody
 * hanging up; the share sounds are a three-note figure on a different wave for
 * exactly that reason, and `call-sound-shapes` holds them apart.
 *
 * **Nothing plays until the reader has interacted with the page**, because no
 * browser will allow it and trying is how a console fills with errors. An
 * AudioContext created before that lands in `suspended`, so the context is made
 * on first use and resumed each time; a ring that cannot start returns a stop
 * function anyway, so no caller has to care.
 *
 * **A ring is scheduled whole, not repeated by a timer.** Every pass of it goes
 * onto the audio clock at once and the stop function silences the ones that have
 * not happened yet. A `setInterval` would have been simpler and was what this
 * did: a browser throttles one to about a minute in a tab nobody is looking at,
 * so the ring sounded once and then gave up in silence - in exactly the case it
 * exists for.
 */

import type { Season } from "@polaris/core";
import { soundGain } from "@/lib/notification-sound";
import { soundSeason } from "@/lib/sound-season";

/** One note: where it starts, where it ends, and how long it takes. */
export interface Note {
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
    | "handUp"
    | "ring"
    | "ringBack";

/**
 * How loud the incoming ring is.
 *
 * Several times everything else here, and that is the point of it: every other
 * sound is played to somebody already looking at the screen, and this one is
 * played to somebody who is not in the room.
 *
 * It is not the height of what comes out, which is the mistake the note beside
 * it used to make - it claimed a single oscillator sounded at a time. Three of
 * the ring's notes overlap, each of them a bell of three partials, so nine
 * oscillators reach the output together and the sum peaks at about twice this.
 * The ceiling that matters is TWO rings at once, which one device with two tabs
 * can produce (see `device-once`): past full scale the output is clipped flat,
 * and clipping is heard as distortion rather than as volume. `call-ring`
 * computes the sum and holds this to it.
 */
const RING_GAIN = 0.22;

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
    /**
     * A screen went up.
     *
     * Three notes and a brighter wave, which is the whole point of it: this was
     * two notes rising a fifth on a sine, and so were arriving, leaving and
     * hanging up - the same gesture at four slightly different pitches. Nobody
     * can name an interval off a laptop speaker, so a screen going up was heard
     * as somebody joining and a screen coming down as somebody hanging up, which
     * is the worst of the four to be wrong about.
     *
     * What tells two sounds apart is their shape - how many notes, how fast, and
     * what they are made of - not which note they start on. So a share is a quick
     * three-note figure on a triangle wave: more notes than any of the plain
     * events, and audibly a different instrument from all of them.
     */
    shareOn: [
        { from: 659.25, at: 0, seconds: 0.05, wave: "triangle" },
        { from: 830.61, at: 0.045, seconds: 0.05, wave: "triangle" },
        { from: 1108.73, at: 0.09, seconds: 0.14, wave: "triangle" }
    ],
    /** A screen came down. The same three notes, the other way down. */
    shareOff: [
        { from: 1108.73, at: 0, seconds: 0.05, wave: "triangle" },
        { from: 830.61, at: 0.045, seconds: 0.05, wave: "triangle" },
        { from: 659.25, at: 0.09, seconds: 0.16, wave: "triangle" }
    ],
    /**
     * Somebody put a hand up, played to whoever is chairing.
     *
     * Two notes upwards and quiet with it, close to the message sound on
     * purpose: it is a request for attention rather than an event in the call,
     * and it lands on somebody who is already listening to people talk. Only the
     * host hears it - see `use-sfu-call` - because a room where everybody chimed
     * at everybody is a room that learns to ignore the chime.
     */
    handUp: [
        { from: 587.33, at: 0, seconds: 0.06, gain: 0.06 },
        { from: 880.0, at: 0.055, seconds: 0.11, gain: 0.06 }
    ],
    /**
     * You hung up, or the call ended under you.
     *
     * Three notes falling away rather than two, and the last one held: the same
     * reason the share sounds are three, applied to the other end of the same
     * collision. Two notes falling on a sine was also what somebody leaving the
     * call sounded like, a fifth higher - and the difference between somebody
     * stepping out and the call being over is not a difference worth guessing at.
     */
    hangUp: [
        { from: 466.16, at: 0, seconds: 0.1 },
        { from: 349.23, at: 0.09, seconds: 0.1 },
        { from: 261.63, at: 0.18, seconds: 0.3 }
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
 * The seasonal sound packs: the ring and the message blip, recast for each time
 * of year, played only to an account that asked for them (see `seasons` in
 * @polaris/core - Discord's own packs went opt-in after it turned them on for
 * everybody).
 *
 * Only the two sounds that carry the season. Join, leave, share and hang-up are
 * signals somebody tells apart by their shape, and a season that reshaped them
 * would make a call harder to follow for a fortnight.
 *
 * Each ring keeps the default's skeleton - three overlapping bells, a breath,
 * the same three again, at the same gain and on the same timings - so what
 * `call-ring` proves about loudness and fit holds for every pack, and
 * `seasonal-sounds` checks that it does. What changes is the notes and the
 * wave: that is what makes a season recognisable in the first half-second.
 */
function ringOf(
    notes: readonly [number, number, number],
    extra: Partial<Note> = {}
): readonly Note[] {
    const [a, b, c] = notes;
    return [
        { from: a, at: 0, seconds: 1, gain: RING_GAIN, bell: true, ...extra },
        { from: b, at: 0.16, seconds: 1, gain: RING_GAIN, bell: true, ...extra },
        { from: c, at: 0.32, seconds: 1.2, gain: RING_GAIN, bell: true, ...extra },
        { from: a, at: 1.1, seconds: 1, gain: RING_GAIN, bell: true, ...extra },
        { from: b, at: 1.26, seconds: 1, gain: RING_GAIN, bell: true, ...extra },
        { from: c, at: 1.42, seconds: 1.3, gain: RING_GAIN, bell: true, ...extra }
    ];
}

export const SEASONAL_SOUNDS: Record<Season, Partial<Record<CallSound, readonly Note[]>>> = {
    /** A minor triad sliding down a semitone on a triangle: a theremin, roughly. */
    halloween: {
        ring: ringOf([440, 523.25, 659.25], { wave: "triangle" }).map((note) => ({
            ...note,
            to: note.from * 0.944
        })),
        message: [
            { from: 659.25, to: 622.25, at: 0, seconds: 0.07, gain: 0.05, wave: "triangle" },
            { from: 466.16, to: 440, at: 0.06, seconds: 0.1, gain: 0.05, wave: "triangle" }
        ]
    },
    /** Sleigh bells: a major arpeggio high up, struck quickly. */
    winter: {
        ring: ringOf([783.99, 987.77, 1174.66]),
        message: [
            { from: 1318.51, at: 0, seconds: 0.06, gain: 0.05, bell: true },
            { from: 1567.98, at: 0.05, seconds: 0.09, gain: 0.05, bell: true }
        ]
    },
    /** A fanfare climbing to the octave, and a three-note sparkle. */
    newYear: {
        ring: ringOf([523.25, 659.25, 1046.5]),
        message: [
            { from: 1046.5, at: 0, seconds: 0.04, gain: 0.05 },
            { from: 1318.51, at: 0.035, seconds: 0.04, gain: 0.05 },
            { from: 1567.98, at: 0.07, seconds: 0.08, gain: 0.05 }
        ]
    },
    /** Pentatonic, the way a festival tune is: D, E and A. */
    lunarNewYear: {
        ring: ringOf([587.33, 659.25, 880]),
        message: [
            { from: 587.33, at: 0, seconds: 0.06, gain: 0.05, bell: true },
            { from: 880, at: 0.05, seconds: 0.09, gain: 0.05, bell: true }
        ]
    }
};

/** What a sound is made of right now: the season's version where it has one. */
export function notesFor(name: CallSound, season: Season | null = soundSeason()): readonly Note[] {
    return (season ? SEASONAL_SOUNDS[season][name] : undefined) ?? SOUNDS[name];
}

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

/**
 * How many passes cover the span a ring is allowed to ring for.
 *
 * Every one of them is scheduled on the audio clock the moment the ring starts,
 * and that is the whole point rather than an optimisation: a repeat driven by
 * `setInterval` is throttled to about once a minute in a tab nobody is looking
 * at, which is every tab a call arrives in. The ring rang once and then stopped
 * for the rest of its forty-five seconds, and the code looked correct - the
 * timer was simply not being run. The audio thread is not throttled.
 */
export function ringPasses(name: "ring" | "ringBack"): number {
    return Math.max(1, Math.ceil(RING_FOR_MS / RING_EVERY_MS[name]));
}

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
    const Ctor =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    // Suspended is the ordinary state for a context made before the reader
    // pressed anything. Resuming is refused rather than throwing, and the next
    // sound tries again.
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    return context;
}

/** One pass of a sound, scheduled to begin at `start` on the audio clock, and
 *  the oscillators it will use - which is what lets a ring scheduled minutes
 *  ahead be silenced the moment somebody answers. */
function schedule(
    ctx: AudioContext,
    name: CallSound,
    start: number,
    level: number,
    season: Season | null = soundSeason()
): OscillatorNode[] {
    const made: OscillatorNode[] = [];
    for (const note of notesFor(name, season)) {
        // One partial, or three of them. `sound` is the whole note: the tone
        // itself is the first call and a bell adds its octave and its twelfth
        // over the top, each quieter and all fading together.
        made.push(sound(ctx, note, start, 1, level));
        if (!note.bell) continue;
        made.push(sound(ctx, note, start, 2, OCTAVE_SHARE * level));
        made.push(sound(ctx, note, start, 3, TWELFTH_SHARE * level));
    }
    return made;
}

/** Play one sound, once - the season's version where one is in force, or the
 *  named season's for a preview. Does nothing at all where audio is not
 *  available. */
export function playCallSound(name: CallSound, season: Season | null = soundSeason()): void {
    // The account's volume, applied to every tone here. Zero is silence rather
    // than a scheduled tone: a gain ramp to zero throws.
    const level = soundGain();
    if (level <= 0) return;
    const ctx = audio();
    if (!ctx) return;
    schedule(ctx, name, ctx.currentTime, level, season);
}

/**
 * Whether a sound started here will actually be heard.
 *
 * No browser lets a page make a noise before it has been interacted with, and a
 * context that is still suspended is one whose notes nobody hears. A call asks
 * this twice over: it decides whether the notice drawn outside the window rings,
 * so that one event makes one sound - the ring where the ring can be heard, the
 * notice where it cannot - and it decides whether a notice is drawn at all,
 * because a tab that cannot be heard has nothing else to offer.
 *
 * **It waits for the browser's answer, and that is the point of it.** Reading
 * the context's state is the wrong question at the one moment this is asked: the
 * ring and the notice are settled in the same breath, and the context the ring
 * has just made is `suspended` until the browser answers the request to resume
 * it. A state read there says "cannot be heard" about a tab that is a
 * millisecond from ringing - which is a call with two sounds over each other,
 * and the thing the single claim exists to prevent.
 */
export async function willBeHeard(): Promise<boolean> {
    // A volume of zero is somebody saying no, not a context that has not started:
    // nothing is resumed to find that out.
    if (soundGain() <= 0) return false;
    const ctx = audio();
    if (!ctx) return false;
    if (ctx.state !== "running") {
        // Refused rather than thrown at, which is what a browser does with a
        // context no gesture has unlocked.
        try {
            await ctx.resume();
        } catch {
            return false;
        }
    }
    return ctx.state === "running";
}

/** One oscillator: the note at some multiple of its frequency, at some share of
 *  its volume, with the note's own envelope. */
function sound(
    ctx: AudioContext,
    note: Note,
    start: number,
    multiple: number,
    share: number
): OscillatorNode {
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
    // Kept above the floor the envelope starts from, so a very low volume still
    // rises rather than ramping downwards.
    const peak = Math.max((note.gain ?? DEFAULT_GAIN) * share, 0.0002);
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
    return oscillator;
}

/**
 * Ring until the returned function is called, or until it gives up.
 *
 * The first pass is immediate: a ring that waits for its own interval before the
 * first sound is a ring that is missed.
 */
export function startRinging(name: "ring" | "ringBack" = "ring"): () => void {
    const level = soundGain();
    const ctx = level > 0 ? audio() : null;
    if (!ctx) return () => undefined;

    const every = RING_EVERY_MS[name] / 1000;
    const made: OscillatorNode[] = [];
    for (let pass = 0; pass < ringPasses(name); pass += 1) {
        made.push(...schedule(ctx, name, ctx.currentTime + pass * every, level));
    }
    return () => {
        // Answered, declined, or hushed. A node whose start is still in the
        // future is told to stop before it - which the spec answers by never
        // playing it at all - so the rest of the ring simply does not happen.
        for (const oscillator of made) {
            try {
                oscillator.stop(ctx.currentTime);
            } catch {
                // Already finished. Nothing to silence.
            }
        }
    };
}
