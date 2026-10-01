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

class FakeContext {
    state = "suspended";
    currentTime = 0;
    readonly audioWorklet = { addModule: async () => {} };
    async resume(): Promise<void> {
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

const { filterMic } = await import("@/app/(app)/chat/mic-filter");
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
