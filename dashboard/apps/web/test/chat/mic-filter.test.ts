/**
 * The graph between a microphone and the call, when it cannot be built.
 *
 * Every case here is a failure to build one, because that is where the damage
 * is. A filter that works is audible; a filter that quietly does not is a call
 * publishing a live track carrying nothing - and a live track carrying nothing
 * is indistinguishable, at every point a screen can look, from a microphone
 * that is working. Nobody hears anybody, both ends report themselves fine, and
 * the reader has no reason to suspect the noise setting they turned on last
 * week.
 *
 * So what is asserted is that a model which will not load never costs anybody
 * their voice: either the level graph is built without it and works, or the
 * microphone is handed back untouched. What must never happen is a track being
 * returned from a context that is not running.
 */

import { describe, expect, it, vi } from "vitest";

/** The models refuse to load - a browser without the wasm features they want, or
 *  assets that never reached the deployment. */
vi.mock("@sapphi-red/web-noise-suppressor", () => {
    throw new Error("no suppressor here");
});

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true
});

/** Every context built in a case, so a test can ask what happened to them. */
const contexts: FakeContext[] = [];

class FakeNode {
    connect(): void {}
    disconnect(): void {}
}

class FakeParam {
    value = 0;
}

class FakeContext {
    state: "running" | "suspended" | "closed" = "suspended";
    readonly destinationTrack = { id: "filtered", kind: "audio", stop: () => {} };

    constructor() {
        contexts.push(this);
    }

    async resume(): Promise<void> {
        this.state = "running";
    }
    async close(): Promise<void> {
        this.state = "closed";
    }
    createMediaStreamSource(): FakeNode {
        return new FakeNode();
    }
    createMediaStreamDestination(): { stream: { getAudioTracks: () => unknown[] } } {
        return { stream: { getAudioTracks: () => [this.destinationTrack] } };
    }
    createGain(): FakeNode & { gain: FakeParam } {
        return Object.assign(new FakeNode(), { gain: new FakeParam() });
    }
    createDynamicsCompressor(): FakeNode & Record<string, FakeParam> {
        return Object.assign(new FakeNode(), {
            threshold: new FakeParam(),
            knee: new FakeParam(),
            ratio: new FakeParam(),
            attack: new FakeParam(),
            release: new FakeParam()
        });
    }
}

/** A context that will not start, which is the other way this produces silence:
 *  a suspended graph is a destination node handing back a live track with
 *  nothing in it. */
class DeafContext extends FakeContext {
    override async resume(): Promise<void> {
        // Refused. Chrome does this to a context built outside a gesture.
    }
}

vi.stubGlobal("AudioContext", FakeContext);
vi.stubGlobal("MediaStream", class {});

const { filterMic } = await import("@/app/(app)/chat/mic-filter");

const track = { id: "device", enabled: true } as unknown as MediaStreamTrack;

describe("a model that will not load", () => {
    it("still builds the level somebody asked for, on a context that is running", async () => {
        contexts.length = 0;
        const built = await filterMic(track, "enhanced", null, 1.5);
        expect(built).not.toBeNull();
        // The whole bug: the context used to be closed the moment the model
        // failed, and the rest of the graph was then built on the corpse. What
        // came back was a live track carrying nothing, published as somebody's
        // voice.
        expect(contexts.every((context) => context.state === "running")).toBe(true);
        expect(built?.using).toBe("gain");
    });

    it("hands the microphone back untouched when there was no level to keep", async () => {
        contexts.length = 0;
        expect(await filterMic(track, "enhanced", null, 1)).toBeNull();
        // Nothing is left running for a graph nobody is using.
        expect(contexts.every((context) => context.state === "closed")).toBe(true);
    });

    it("lets go of the graph when it is stopped", async () => {
        contexts.length = 0;
        const built = await filterMic(track, "enhanced", null, 1.5);
        await built?.stop();
        expect(contexts.every((context) => context.state === "closed")).toBe(true);
    });
});

describe("a context that will not start", () => {
    it("is no filter rather than a silent one", async () => {
        contexts.length = 0;
        vi.stubGlobal("AudioContext", DeafContext);
        try {
            // A suspended context produces silence, and silence published as a
            // voice is worse than no filter at all.
            expect(await filterMic(track, "enhanced", null, 1.5)).toBeNull();
            expect(contexts.every((context) => context.state === "closed")).toBe(true);
        } finally {
            vi.stubGlobal("AudioContext", FakeContext);
        }
    });
});

describe("a microphone nothing has to be done to", () => {
    it("builds no graph at all", async () => {
        contexts.length = 0;
        expect(await filterMic(track, "standard", null, 1)).toBeNull();
        expect(contexts).toHaveLength(0);
    });
});
