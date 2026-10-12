/**
 * The level of a microphone that goes through the noise model.
 *
 * Reported as one person being very quiet for everybody in a call. Two things in
 * the graph are pinned here: the level after the model is measured and lifted
 * (not a fixed makeup), and the volume somebody sets reaches a graph that is
 * already running instead of waiting for the next call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A model that loads, and passes whatever it is given. */
vi.mock("@sapphi-red/web-noise-suppressor", () => ({
    loadGtcrn: async () => new ArrayBuffer(8),
    GtcrnWorkletNode: class {
        channelCount = 1;
        channelCountMode = "max";
        channelInterpretation = "speakers";
        connect(): void {}
        disconnect(): void {}
        destroy(): void {}
    }
}));

vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    dispatchEvent: () => true
});

class FakeParam {
    value = 0;
    readonly targets: number[] = [];
    setTargetAtTime(value: number): void {
        this.targets.push(value);
        this.value = value;
    }
}

class FakeNode {
    channelCount = 2;
    channelCountMode = "max";
    channelInterpretation = "speakers";
    connect(): void {}
    disconnect(): void {}
}

/** What the analyser after the model reads: a constant level, set per test. */
let heardAmplitude = 0;

const gains: (FakeNode & { gain: FakeParam })[] = [];

/** Every context built, so a test can move its clock. */
const contexts: FakeContext[] = [];

class FakeContext {
    state = "suspended";
    currentTime = 0;
    resumes = 0;
    constructor() {
        contexts.push(this);
    }
    readonly audioWorklet = { addModule: async () => {} };
    async resume(): Promise<void> {
        this.resumes += 1;
        this.state = "running";
    }
    async close(): Promise<void> {
        this.state = "closed";
    }
    createMediaStreamSource(): FakeNode {
        return new FakeNode();
    }
    createMediaStreamDestination() {
        return Object.assign(new FakeNode(), {
            stream: { getAudioTracks: () => [{ id: "filtered", stop: () => {} }] }
        });
    }
    createGain() {
        const node = Object.assign(new FakeNode(), { gain: new FakeParam() });
        gains.push(node);
        return node;
    }
    createAnalyser() {
        return Object.assign(new FakeNode(), {
            fftSize: 2048,
            getFloatTimeDomainData(out: Float32Array) {
                for (let index = 0; index < out.length; index += 1)
                    out[index] = index % 2 === 0 ? heardAmplitude : -heardAmplitude;
            }
        });
    }
    createDynamicsCompressor() {
        return Object.assign(new FakeNode(), {
            threshold: new FakeParam(),
            knee: new FakeParam(),
            ratio: new FakeParam(),
            attack: new FakeParam(),
            release: new FakeParam()
        });
    }
}

vi.stubGlobal("AudioContext", FakeContext);
// The graph checks what the model hands back is a node it can connect.
vi.stubGlobal("AudioNode", FakeNode);
vi.stubGlobal("MediaStream", class {});

const { filterMic, keepingTime } = await import("@/app/(app)/chat/mic-filter");
const { dbToGain, START_GAIN_DB, MAX_GAIN_DB } = await import("@/app/(app)/chat/mic-leveller");

const track = { id: "device", enabled: true } as unknown as MediaStreamTrack;

beforeEach(() => {
    gains.length = 0;
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe("a voice through the model", () => {
    it("starts at the old makeup and is lifted when it leaves the model quiet", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        expect(built?.using).toBe("enhanced");
        const [leveller, volume] = gains;
        expect(leveller?.gain.value).toBeCloseTo(dbToGain(START_GAIN_DB), 5);
        expect(volume?.gain.value).toBe(1);

        // -46 dBFS out of the model: a voice the model left well under a
        // speaking level.
        heardAmplitude = 10 ** (-46 / 20);
        vi.advanceTimersByTime(30_000);
        expect(leveller?.gain.value).toBeCloseTo(dbToGain(MAX_GAIN_DB), 3);
        await built?.stop();
    });

    it("is not lifted through a pause", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        const [leveller] = gains;
        heardAmplitude = 0;
        vi.advanceTimersByTime(30_000);
        expect(leveller?.gain.value).toBeCloseTo(dbToGain(START_GAIN_DB), 5);
        await built?.stop();
    });

    it("takes a new volume while it runs, on its own node", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        const [leveller, volume] = gains;
        built?.setGain(1.75);
        expect(volume?.gain.value).toBe(1.75);
        expect(leveller?.gain.value).toBeCloseTo(dbToGain(START_GAIN_DB), 5);
        // Nonsense is refused rather than multiplied into somebody's voice.
        built?.setGain(Number.NaN);
        built?.setGain(-1);
        expect(volume?.gain.value).toBe(1.75);
        await built?.stop();
    });

    it("stops measuring when it is stopped", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        const [leveller] = gains;
        await built?.stop();
        heardAmplitude = 10 ** (-46 / 20);
        vi.advanceTimersByTime(10_000);
        expect(leveller?.gain.value).toBeCloseTo(dbToGain(START_GAIN_DB), 5);
    });
});

describe("a volume-only graph", () => {
    it("has no lift in it, only the volume", async () => {
        const built = await filterMic(track, "standard", null, 1.5);
        expect(built?.using).toBe("gain");
        const [leveller, volume] = gains;
        expect(leveller?.gain.value).toBe(1);
        expect(volume?.gain.value).toBe(1.5);
        await built?.stop();
    });
});

/**
 * A filter that stops making sound mid-call.
 *
 * Reported as one person nobody could hear until they left and rejoined: the
 * server saw their packets with timestamps drifting from the wall clock, which is
 * a graph that stopped keeping time while its track stayed live.
 */
describe("a filter that stops", () => {
    /** Run the graph's clock alongside the wall's, or hold it still. */
    function tick(context: FakeContext, seconds: number, moving: boolean): void {
        for (let step = 0; step < seconds / 2; step += 1) {
            if (moving) context.currentTime += 2;
            vi.advanceTimersByTime(2_000);
        }
    }

    it("is not reported while it keeps time", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        const context = contexts.at(-1)!;
        let stalls = 0;
        built?.onStall(() => (stalls += 1));
        tick(context, 30, true);
        expect(stalls).toBe(0);
        await built?.stop();
    });

    it("is reported once when its clock stops, after asking it to resume", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        const context = contexts.at(-1)!;
        let stalls = 0;
        built?.onStall(() => (stalls += 1));
        context.state = "interrupted";
        const resumedBefore = context.resumes;
        tick(context, 4, false);
        expect(stalls).toBe(0);
        tick(context, 30, false);
        expect(stalls).toBe(1);
        expect(context.resumes).toBeGreaterThan(resumedBefore);
        await built?.stop();
    });

    it("forgives one slow moment", async () => {
        const built = await filterMic(track, "enhanced", null, 1);
        const context = contexts.at(-1)!;
        let stalls = 0;
        built?.onStall(() => (stalls += 1));
        tick(context, 4, false);
        tick(context, 30, true);
        expect(stalls).toBe(0);
        await built?.stop();
    });

    it("keeps time only while running and at least half as fast as the wall", () => {
        expect(keepingTime(2, 2_000, true)).toBe(true);
        expect(keepingTime(0.9, 2_000, true)).toBe(false);
        expect(keepingTime(2, 2_000, false)).toBe(false);
        expect(keepingTime(0, 0, true)).toBe(true);
    });
});
