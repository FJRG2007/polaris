"use client";

/**
 * Finding out which of the people in a call are sitting in this room.
 *
 * Nothing on a network can answer that. Two laptops in the same meeting room and
 * two laptops on opposite sides of a country look identical to a call server:
 * same room, same connection, often the same office address. The only thing that
 * is true of one pair and not the other is that they can *hear* each other - so
 * that is what is measured.
 *
 * Each browser in the call plays a short tone at a frequency of its own and
 * listens for everybody else's. The tones sit between 18.4 and 19.7 kHz, which
 * is above the top of adult hearing and below what a laptop's speakers and
 * microphone stop reproducing, and they are played quietly and in bursts of a
 * fraction of a second. What that buys is exactly the property wanted: sound at
 * that frequency barely survives a wall, a closed door or a few metres of open
 * office, so hearing somebody's tone is very close to "they are within a few
 * metres of you". A dog and a teenager may notice; the call will not.
 *
 * Three things make this honest rather than clever:
 *
 * - **It only ever suggests.** Nothing is combined because of what is heard
 *   here - a person is asked, and the worst a false positive costs is a strip
 *   somebody dismisses. That is the whole reason a rough acoustic measurement is
 *   allowed to have an opinion at all, and it is what makes the one unavoidable
 *   false positive tolerable: a tone leaks into the call itself through the
 *   microphone that played it, so somebody a continent away can in principle
 *   hear it come out of their own speakers.
 * - **It listens through the microphone the call is already using**, and opens
 *   nothing of its own. A second `getUserMedia` on the same device is the kind
 *   of thing that works on a desktop and takes the call away from itself on a
 *   phone, and no feature that only ever produces a suggestion is worth that
 *   risk. The cost is that a browser whose microphone is muted hears nothing -
 *   which is survivable, because it is still *playing* its tone, so the other
 *   device in the room hears it and is offered the same suggestion.
 * - **It runs for a few seconds and stops.** Scans are triggered by the roster
 *   changing, which every browser in the call sees at the same moment - so
 *   everybody is listening while everybody else is playing, without a clock to
 *   agree on.
 *
 * The slot a browser plays in is its position in the sorted roster of the call,
 * which every browser already has and all of them sort the same way. No
 * negotiation, no allocation, nothing to keep in step.
 */

/** How many tones there is room for: the same ceiling a call has, because a slot
 *  per person in the room is the whole scheme. Not imported from the meeting
 *  module, which reaches the database and has no business in a browser. */
export const NEARBY_SLOTS = 8;

/** Where the slots start. Above where adults hear and well inside what ordinary
 *  hardware still reproduces - the roll-off starts in earnest past 20 kHz. */
const BASE_HZ = 18_400;
/** How far apart they sit. Far enough that the leakage either side of one tone
 *  cannot be mistaken for its neighbour. */
const STEP_HZ = 180;

/** Under this, the top slot would be above the highest frequency the browser can
 *  represent and the whole scheme is meaningless. 44.1 kHz sampling leaves
 *  22 kHz, which is enough; a context that opens lower than this is a machine
 *  where this feature simply does not run. */
const MIN_SAMPLE_RATE = 44_000;

/** How finely the spectrum is cut. At 48 kHz this is a bin every 5.9 Hz, so a
 *  slot is thirty bins from its neighbour and a couple of bins of drift cost
 *  nothing. */
const FFT_SIZE = 8192;

/** How far either side of a slot's exact frequency to look, in bins. Two devices
 *  never agree on a sample rate to the hertz, and a window costs nothing. */
const SPREAD_BINS = 2;

/** How far above the room's own noise a tone has to be to count. Twelve decibels
 *  is a tone that is plainly there rather than one the arithmetic found. */
const MARGIN_DB = 12;

/** Below this, it is silence being measured rather than a tone. A microphone
 *  reports a floor around -100 dB with nothing happening at all. */
const FLOOR_DB = -85;

/** How long a scan listens for, by default. Long enough for several bursts from
 *  everybody, short enough that nobody notices the microphone was busy. */
const SCAN_SECONDS = 5;

/** How often the spectrum is read. */
const SAMPLE_MS = 100;

/** How many readings a slot has to be heard in before it is believed. A single
 *  loud reading is a chair being scraped. */
const HITS = 3;

/** How loud the tone is played. Quiet: it only has to cross a room, and every
 *  decibel of it is also going into this browser's own microphone. */
const TONE_GAIN = 0.03;

/** How long one burst lasts, and how often bursts come. Bursts rather than a
 *  held tone so that anything in the room which does respond to it - an animal,
 *  a badly behaved microphone - is not subjected to it continuously. */
const BURST_MS = 160;
const BURST_EVERY_MS = 420;

/** Whether this browser takes part at all. Per browser, like the volumes and the
 *  microphone cleanup: it is a decision about a machine in a room. */
const KEY = "polaris.call.nearby";

export function nearbyEnabled(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(KEY) !== "0";
    } catch {
        // Storage refused - a browser with it disabled, or a full quota.
        return true;
    }
}

export function setNearbyEnabled(enabled: boolean): void {
    if (typeof window === "undefined") return;
    try {
        if (enabled) window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, "0");
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
}

/** The frequency one slot plays at. */
export function slotHz(slot: number): number {
    return BASE_HZ + slot * STEP_HZ;
}

/** Which bin of the spectrum a frequency lands in. */
export function binOf(hz: number, sampleRate: number, fftSize: number): number {
    return Math.round((hz * fftSize) / sampleRate);
}

/**
 * Which slots are audible in one reading of the spectrum.
 *
 * Measured against the room rather than against a fixed level, because "loud"
 * means nothing on its own: a laptop fan, a projector and an air conditioner all
 * put energy up here, and a threshold that worked in a quiet office would find
 * tones in every noisy one. So the floor is the middle of the band this uses -
 * a value a handful of tones cannot move - and a slot counts when it stands
 * clearly above it and is not merely the quietest kind of silence.
 *
 * Pure, and separated from everything that opens a device, because it is the
 * only part that can be wrong in a way a test can catch.
 *
 * @param spectrum - Decibels per bin, as `getFloatFrequencyData` writes them.
 */
export function slotsHeard(
    spectrum: ArrayLike<number>,
    sampleRate: number,
    fftSize: number
): number[] {
    const first = binOf(BASE_HZ - STEP_HZ, sampleRate, fftSize);
    const last = binOf(slotHz(NEARBY_SLOTS - 1) + STEP_HZ, sampleRate, fftSize);
    if (last >= spectrum.length) return [];

    const band: number[] = [];
    for (let bin = first; bin <= last; bin += 1) {
        const value = spectrum[bin];
        // Silence is reported as -Infinity by some browsers, which is not a
        // number the middle of a band can be worked out from.
        if (typeof value === "number" && Number.isFinite(value)) band.push(value);
    }
    if (band.length === 0) return [];
    band.sort((a, b) => a - b);
    const floor = band[Math.floor(band.length / 2)] ?? FLOOR_DB;

    const heard: number[] = [];
    for (let slot = 0; slot < NEARBY_SLOTS; slot += 1) {
        const centre = binOf(slotHz(slot), sampleRate, fftSize);
        let peak = Number.NEGATIVE_INFINITY;
        for (let bin = centre - SPREAD_BINS; bin <= centre + SPREAD_BINS; bin += 1) {
            const value = spectrum[bin];
            if (typeof value === "number" && value > peak) peak = value;
        }
        if (peak > FLOOR_DB && peak > floor + MARGIN_DB) heard.push(slot);
    }
    return heard;
}

/** What a scan found. */
export interface NearbyScan {
    /** The slots whose tone was heard in this room, this browser's own never
     *  among them. */
    readonly heard: ReadonlySet<number>;
    /**
     * Whether anything was actually listened to.
     *
     * A scan that only played its tone - because this browser has no microphone
     * open, or the person is muted - is not evidence that the room is empty, and
     * must not be allowed to take back what an earlier scan heard.
     */
    readonly listened: boolean;
}

const NOTHING: NearbyScan = { heard: new Set(), listened: false };

/**
 * Play this browser's tone, listen for everybody else's, and say who was heard.
 *
 * Everything opened here is closed here, on every path out including the one
 * where the caller gave up waiting - a scan that left an oscillator running
 * would put a tone into the room for the rest of the call.
 *
 * @param mySlot - This browser's position in the sorted roster. Its own tone is
 *   never reported as heard, however loudly its own microphone picks it up.
 * @param microphone - The track the call is already using. Nothing is opened
 *   here: see the note at the top of the file. A track that is absent or
 *   disabled means this browser plays its tone and hears nothing, which is
 *   answered as `listened: false` rather than as an empty room.
 * @param signal - Cancels the scan; everything is closed and what was heard so
 *   far is thrown away.
 */
export async function scanNearby(options: {
    mySlot: number;
    seconds?: number;
    microphone?: MediaStreamTrack | null;
    signal?: AbortSignal;
}): Promise<NearbyScan> {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return NOTHING;
    if (options.mySlot < 0 || options.mySlot >= NEARBY_SLOTS) return NOTHING;

    const context = new AudioContext();
    // A machine that cannot represent the range the tones sit in. Nothing to be
    // done about it and nothing worth saying: combining is still there to be
    // pressed by hand on somebody's tile.
    if (context.sampleRate < MIN_SAMPLE_RATE) {
        await context.close().catch(() => undefined);
        return NOTHING;
    }

    const track = options.microphone;
    const listening = Boolean(track && track.readyState === "live" && track.enabled);

    const gain = context.createGain();
    gain.gain.value = 0;
    const tone = context.createOscillator();
    tone.type = "sine";
    tone.frequency.value = slotHz(options.mySlot);
    tone.connect(gain);
    gain.connect(context.destination);
    tone.start();

    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    if (listening && track) {
        analyser = context.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        // No averaging with the previous reading: a burst is shorter than the
        // smooth the browser would apply, and this is looking for exactly that
        // burst.
        analyser.smoothingTimeConstant = 0;
        // Built over a stream of the call's own track. The device is already
        // open, so this costs a graph node and nothing else.
        source = context.createMediaStreamSource(new MediaStream([track]));
        source.connect(analyser);
    }

    // A context made before the reader has interacted with the page opens
    // suspended, which is a scan that plays nothing and hears everybody's tone
    // but its own.
    await context.resume().catch(() => undefined);

    const counts = new Map<number, number>();
    const spectrum = analyser ? new Float32Array(analyser.frequencyBinCount) : null;
    const until = Date.now() + (options.seconds ?? SCAN_SECONDS) * 1000;

    const burst = setInterval(() => {
        const now = context.currentTime;
        // Ramped rather than switched, so the room hears a tone rather than the
        // click a square edge at full amplitude makes.
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(TONE_GAIN, now + 0.02);
        gain.gain.setValueAtTime(TONE_GAIN, now + BURST_MS / 1000);
        gain.gain.linearRampToValueAtTime(0, now + BURST_MS / 1000 + 0.02);
    }, BURST_EVERY_MS);

    try {
        while (Date.now() < until) {
            if (options.signal?.aborted) return NOTHING;
            await new Promise((wake) => setTimeout(wake, SAMPLE_MS));
            if (!analyser || !spectrum) continue;
            analyser.getFloatFrequencyData(spectrum);
            for (const slot of slotsHeard(spectrum, context.sampleRate, FFT_SIZE)) {
                if (slot === options.mySlot) continue;
                counts.set(slot, (counts.get(slot) ?? 0) + 1);
            }
        }
    } finally {
        clearInterval(burst);
        try {
            tone.stop();
        } catch {
            // Already stopped, which is not a failure worth reporting.
        }
        source?.disconnect();
        analyser?.disconnect();
        tone.disconnect();
        gain.disconnect();
        await context.close().catch(() => undefined);
    }

    const heard = new Set<number>();
    for (const [slot, count] of counts) {
        if (count >= HITS) heard.add(slot);
    }
    return { heard, listened: listening };
}
