// @vitest-environment jsdom
/**
 * The mute and deafen buttons, and what each does to the other.
 *
 * Unmuting while deafened undeafens, undeafening gives back the microphone as it
 * was, and a push-to-talk gate that stands down because somebody muted must not
 * reopen the microphone on its way out.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pressDeafen, pressMic, type VoiceControls } from "@/app/(app)/chat/call-voice-controls";

const settings = vi.hoisted(() => ({ inputMode: "open" as "open" | "ptt" | "activity" }));

vi.mock("@/app/(app)/chat/voice-settings", () => ({
    voiceSettings: () => ({
        inputMode: settings.inputMode,
        pttKey: "Space",
        pttReleaseMs: 0,
        activityThreshold: 12
    })
}));

const { useVoiceGate } = await import("@/app/(app)/chat/voice-gate");

const LIVE: VoiceControls = { micOn: true, deafened: false, micBeforeDeafen: true };

describe("the mute button", () => {
    it("mutes a live microphone", () => {
        expect(pressMic(LIVE, false)).toMatchObject({ micOn: false, deafened: false });
    });

    it("undeafens as well when unmuting while deafened", () => {
        const deafened = pressDeafen(LIVE, false);
        expect(deafened).toMatchObject({ micOn: false, deafened: true });
        expect(pressMic(deafened, false)).toMatchObject({ micOn: true, deafened: false });
    });

    it("undeafens even when the microphone was muted before deafening", () => {
        const deafened = pressDeafen({ ...LIVE, micOn: false }, false);
        expect(pressMic(deafened, false)).toMatchObject({ micOn: true, deafened: false });
    });

    it("leaves the audio group instead of opening a quiet device's microphone", () => {
        const quiet = { micOn: false, deafened: false, micBeforeDeafen: true };
        expect(pressMic(quiet, true)).toMatchObject({ micOn: false, leaveGroup: true });
    });
});

describe("the deafen button", () => {
    it("gives the microphone back on undeafen", () => {
        const back = pressDeafen(pressDeafen(LIVE, false), false);
        expect(back).toMatchObject({ micOn: true, deafened: false });
    });

    it("keeps somebody who muted first muted after undeafening", () => {
        const muted = pressMic(LIVE, false);
        const back = pressDeafen(pressDeafen(muted, false), false);
        expect(back).toMatchObject({ micOn: false, deafened: false });
    });

    it("never gives a quiet device its microphone back", () => {
        const back = pressDeafen(pressDeafen(LIVE, true), true);
        expect(back).toMatchObject({ micOn: false, deafened: false });
    });
});

describe("the push-to-talk gate", () => {
    beforeEach(() => {
        settings.inputMode = "ptt";
    });
    afterEach(() => {
        settings.inputMode = "open";
    });

    it("does not reopen the microphone when it stands down for a mute", () => {
        const sent: boolean[] = [];
        const { rerender } = renderHook(
            ({ micOn }) => useVoiceGate({ micOn, track: null, setSending: (on) => sent.push(on) }),
            { initialProps: { micOn: true } }
        );
        expect(sent).toEqual([false]);
        act(() => rerender({ micOn: false }));
        expect(sent).toEqual([false]);
    });

    it("reopens it when the gate itself goes away with the microphone still on", () => {
        const sent: boolean[] = [];
        const { unmount } = renderHook(() =>
            useVoiceGate({ micOn: true, track: null, setSending: (on) => sent.push(on) })
        );
        unmount();
        expect(sent).toEqual([false, true]);
    });
});
