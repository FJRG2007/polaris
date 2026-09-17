/**
 * When the call says your microphone is dead.
 *
 * It used to say so after 45 seconds of anything quieter than a fan, which is
 * what somebody listening in a quiet room reads - so it fired on people who were
 * simply not talking. Asserted here: quiet is never enough, digital silence and
 * a filter swallowing a voice are, a gate holding the track closed is not a
 * fault, and once shown it waits longer before coming back.
 */

import { describe, expect, it } from "vitest";
import {
    DEAD_MS,
    dismissNoAudio,
    FLAT_PEAK,
    NO_AUDIO_START,
    SWALLOWED_MS,
    watchNoAudio,
    type NoAudioWatch
} from "@/app/(app)/chat/no-audio";

const QUIET = 0.0004; // a silent room through noise suppression, about -68 dBFS
const VOICE = 0.2;

/** Feed one reading a second for `ms`, starting at `from`. */
function run(
    state: NoAudioWatch,
    from: number,
    ms: number,
    reading: { device: number; outgoing?: number; sending?: boolean }
): NoAudioWatch {
    let current = state;
    for (let now = from; now <= from + ms; now += 1000) {
        current = watchNoAudio(current, {
            now,
            sending: reading.sending ?? true,
            device: reading.device,
            outgoing: reading.outgoing ?? reading.device
        });
    }
    return current;
}

describe("the dead microphone warning", () => {
    it("never fires for somebody who is only quiet", () => {
        expect(run(NO_AUDIO_START, 0, 10 * 60_000, { device: QUIET }).warning).toBe(false);
    });

    it("fires after a long stretch of digital silence", () => {
        expect(run(NO_AUDIO_START, 0, DEAD_MS - 2000, { device: 0 }).warning).toBe(false);
        expect(run(NO_AUDIO_START, 0, DEAD_MS, { device: 0 }).warning).toBe(true);
    });

    it("clears the moment the device produces anything", () => {
        const dead = run(NO_AUDIO_START, 0, DEAD_MS, { device: 0 });
        expect(run(dead, DEAD_MS + 1000, 0, { device: QUIET }).warning).toBe(false);
    });

    it("does not count time the track is held closed by a gate", () => {
        let state = run(NO_AUDIO_START, 0, DEAD_MS / 2, { device: 0 });
        state = run(state, DEAD_MS / 2 + 1000, 5000, { device: 0, sending: false });
        state = run(state, DEAD_MS / 2 + 7000, DEAD_MS / 2, { device: 0 });
        expect(state.warning).toBe(false);
    });

    it("fires when a voice goes in and nothing comes out", () => {
        const state = run(NO_AUDIO_START, 0, SWALLOWED_MS, { device: VOICE, outgoing: 0 });
        expect(state.warning).toBe(true);
    });

    it("does not blame a filter that removes silence", () => {
        let state = run(NO_AUDIO_START, 0, 3000, { device: VOICE, outgoing: VOICE });
        state = run(state, 4000, 10 * 60_000, { device: QUIET, outgoing: 0 });
        expect(state.warning).toBe(false);
    });

    it("stays up once shown, and waits twice as long the next time", () => {
        let state = run(NO_AUDIO_START, 0, DEAD_MS, { device: 0 });
        expect(state.shown).toBe(1);
        state = run(state, DEAD_MS + 1000, 30_000, { device: 0 });
        expect(state.warning).toBe(true);
        // Back, then dead again: the second warning needs double the window.
        state = run(state, 200_000, 0, { device: FLAT_PEAK * 4 });
        state = run(state, 201_000, DEAD_MS, { device: 0 });
        expect(state.warning).toBe(false);
        state = run(state, 201_000 + DEAD_MS + 1000, DEAD_MS, { device: 0 });
        expect(state.warning).toBe(true);
        expect(state.shown).toBe(2);
    });

    it("stays away for good once closed", () => {
        const closed = dismissNoAudio(run(NO_AUDIO_START, 0, DEAD_MS, { device: 0 }));
        expect(run(closed, DEAD_MS + 1000, 10 * DEAD_MS, { device: 0 }).warning).toBe(false);
    });
});
