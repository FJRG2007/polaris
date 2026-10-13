/**
 * Mute and deafen surviving a reload in the middle of a call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberVoice, takeRememberedVoice } from "@/app/(app)/chat/call-voice-resume";

const MEETING = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";

function fakeStorage() {
    const held = new Map<string, string>();
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value),
        removeItem: (key: string) => void held.delete(key)
    };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
    storage = fakeStorage();
    (globalThis as { window?: unknown }).window = { sessionStorage: storage };
});

afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.useRealTimers();
});

describe("the voice a reload carries", () => {
    it("brings back a muted and deafened person as they were", () => {
        rememberVoice(MEETING, { micOn: false, deafened: true, micBeforeDeafen: false });
        expect(takeRememberedVoice(MEETING)).toEqual({
            micOn: false,
            deafened: true,
            micBeforeDeafen: false
        });
    });

    it("is read once", () => {
        rememberVoice(MEETING, { micOn: false, deafened: false, micBeforeDeafen: true });
        expect(takeRememberedVoice(MEETING)).not.toBeNull();
        expect(takeRememberedVoice(MEETING)).toBeNull();
    });

    it("belongs to the call it was written in", () => {
        rememberVoice(MEETING, { micOn: false, deafened: true, micBeforeDeafen: true });
        expect(takeRememberedVoice("019f8506-0000-7000-8000-000000000009")).toBeNull();
    });

    it("does not outlive a reload", () => {
        vi.useFakeTimers();
        rememberVoice(MEETING, { micOn: false, deafened: true, micBeforeDeafen: true });
        vi.advanceTimersByTime(91_000);
        expect(takeRememberedVoice(MEETING)).toBeNull();
    });

    it("ignores a note that is not one", () => {
        storage.setItem("polaris.call.voice", JSON.stringify({ meetingId: MEETING, micOn: "no" }));
        expect(takeRememberedVoice(MEETING)).toBeNull();
        storage.setItem("polaris.call.voice", "not json");
        expect(takeRememberedVoice(MEETING)).toBeNull();
    });

    it("answers nothing when storage is refused", () => {
        (globalThis as { window?: unknown }).window = {
            get sessionStorage() {
                throw new Error("denied");
            }
        };
        rememberVoice(MEETING, { micOn: false, deafened: true, micBeforeDeafen: true });
        expect(takeRememberedVoice(MEETING)).toBeNull();
    });
});
