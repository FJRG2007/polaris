/**
 * Whether this tab's ring will actually be heard.
 *
 * One boolean, and a call's whole audibility hangs off it: it decides whether the
 * notice drawn outside the window rings, and whether one is drawn at all. Get it
 * wrong in one direction and a call makes two sounds over each other; wrong in
 * the other and it makes none.
 *
 * The case that has to be pinned is the waiting. A browser hands back a
 * `suspended` context and answers the request to resume it a moment later, and
 * the ring and the notice are settled in the same breath - so an answer read from
 * the state as it stands is an answer about a tab that is a millisecond from
 * ringing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** How loud the account has this, as `notification-sound` answers it. */
let gain = 0.6;

vi.mock("@/lib/notification-sound", () => ({
    soundGain: () => gain,
    notificationSoundEnabled: () => true,
    playNotificationSound: () => undefined
}));

/** A browser's audio context: suspended until something asks it to resume, and
 *  refusing that where the page has never been interacted with. */
class FakeContext {
    state: AudioContextState = "suspended";
    currentTime = 0;
    static allowed = true;
    static resumed = 0;

    async resume(): Promise<void> {
        FakeContext.resumed += 1;
        if (!FakeContext.allowed) throw new Error("play() failed because the user didn't interact");
        this.state = "running";
    }
    createOscillator(): unknown {
        return { connect: () => undefined, start: () => undefined, stop: () => undefined };
    }
    createGain(): unknown {
        return {
            connect: () => undefined,
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
    gain = 0.6;
    FakeContext.allowed = true;
    FakeContext.resumed = 0;
    vi.stubGlobal("window", { AudioContext: FakeContext });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

async function sounds() {
    return await import("@/lib/call-sounds");
}

describe("whether a ring will be heard", () => {
    it("waits for the browser to start the audio rather than reading its state", async () => {
        // The context is made suspended and resumed asynchronously. Read rather
        // than awaited, this says no about a tab whose ring is about to sound,
        // and the notice then rings over the top of it.
        const { willBeHeard } = await sounds();

        expect(await willBeHeard()).toBe(true);
        expect(FakeContext.resumed).toBeGreaterThan(0);
    });

    it("says no where the browser refuses to start it", async () => {
        // A page nobody has pressed. This is the tab that makes no sound at all,
        // and the answer here is what sends the sound to the notice instead.
        FakeContext.allowed = false;
        const { willBeHeard } = await sounds();

        expect(await willBeHeard()).toBe(false);
    });

    it("says no at a volume of zero without touching the audio at all", async () => {
        // Somebody turned Polaris down. That is an answer, not a context waiting
        // to be started, and nothing is resumed to find it out.
        gain = 0;
        const { willBeHeard } = await sounds();

        expect(await willBeHeard()).toBe(false);
        expect(FakeContext.resumed).toBe(0);
    });

    it("says no where the browser has no audio at all", async () => {
        vi.stubGlobal("window", {});
        const { willBeHeard } = await sounds();

        expect(await willBeHeard()).toBe(false);
    });
});
