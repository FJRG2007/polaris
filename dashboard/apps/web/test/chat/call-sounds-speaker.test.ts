/**
 * Where a call's tones come out.
 *
 * The call's voices play through the output its speaker picker names, and the
 * tones did not: on a headset the call was in the headset and an incoming ring
 * came out of whatever the system prefers - so a second call arriving during the
 * first rang where nobody could hear it. The tones now follow the same choice,
 * and move with it when it changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notification-sound", () => ({
    soundGain: () => 0.6,
    notificationSoundEnabled: () => true,
    playNotificationSound: () => undefined
}));

/** What the tab has stored as the chosen output. */
let stored: string | null = null;
/** Listeners the module registered, by event name. */
let listeners: Map<string, () => void>;

/** A Chromium audio context, which can be told where to play. */
class FakeContext {
    state: AudioContextState = "running";
    currentTime = 0;
    sinkId = "";
    static made: FakeContext[] = [];
    constructor() {
        FakeContext.made.push(this);
    }
    async setSinkId(id: string): Promise<void> {
        this.sinkId = id;
    }
    async resume(): Promise<void> {}
    createOscillator(): unknown {
        return {
            connect: (next: unknown) => next,
            start: () => undefined,
            stop: () => undefined,
            frequency: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }
        };
    }
    createGain(): unknown {
        return {
            connect: (next: unknown) => next,
            gain: {
                setValueAtTime: () => undefined,
                linearRampToValueAtTime: () => undefined,
                exponentialRampToValueAtTime: () => undefined
            }
        };
    }
    get destination(): unknown {
        return {};
    }
}

beforeEach(() => {
    stored = null;
    listeners = new Map();
    FakeContext.made = [];
    vi.stubGlobal("window", {
        AudioContext: FakeContext,
        localStorage: {
            getItem: () => stored,
            setItem: (_key: string, value: string) => void (stored = value),
            removeItem: () => void (stored = null)
        },
        addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
        dispatchEvent: (event: Event) => listeners.get(event.type)?.()
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("a call's tones", () => {
    it("ring through the output the call was set to", async () => {
        stored = "headset";
        const { startRinging } = await import("@/lib/call-sounds");
        startRinging("ring")();
        expect(FakeContext.made).toHaveLength(1);
        expect(FakeContext.made[0].sinkId).toBe("headset");
    });

    it("stay on the system's own output when nothing was chosen", async () => {
        const { startRinging } = await import("@/lib/call-sounds");
        startRinging("ring")();
        expect(FakeContext.made[0].sinkId).toBe("");
    });

    it("move when the choice changes, a ring already sounding included", async () => {
        const { startRinging } = await import("@/lib/call-sounds");
        const { setSpeakerDevice } = await import("@/lib/speaker-choice");
        const stop = startRinging("ring");
        setSpeakerDevice("headset");
        expect(FakeContext.made[0].sinkId).toBe("headset");
        stop();
    });

    it("try the chosen output again on the next sound when it was not there yet", async () => {
        stored = "headset";
        const { playCallSound } = await import("@/lib/call-sounds");
        const original = FakeContext.prototype.setSinkId;
        FakeContext.prototype.setSinkId = () => Promise.reject(new Error("NotFoundError"));
        playCallSound("ring");
        await Promise.resolve();
        expect(FakeContext.made[0].sinkId).toBe("");
        FakeContext.prototype.setSinkId = original;
        playCallSound("ring");
        await Promise.resolve();
        expect(FakeContext.made).toHaveLength(1);
        expect(FakeContext.made[0].sinkId).toBe("headset");
    });
});
