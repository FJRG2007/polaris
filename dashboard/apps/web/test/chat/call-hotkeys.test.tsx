// @vitest-environment jsdom

/**
 * F9 and F10, wherever the reader is while a call is on.
 *
 * They were bound by the room, so they did nothing on any other page while the
 * call bar there said "Deafen (F10)". What is pinned here is that the call's
 * holder binds them for as long as there is a call and not a moment longer, and
 * that one press is one toggle.
 */

import type { CallSession } from "@/app/(app)/chat/call-hold";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHotkey, useCallHotkeys } from "@/app/(app)/chat/call-hotkeys";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

const controls = vi.hoisted(() => ({ toggleMic: vi.fn(), toggleDeafen: vi.fn() }));

vi.mock("@/app/(app)/chat/use-call", () => ({
    useCall: () => ({ ended: false, ...controls })
}));
vi.mock("@/app/(app)/chat/call-recorder", () => ({
    useCallRecorder: () => ({ running: false, stop: () => undefined })
}));
vi.mock("@/app/(app)/chat/call-audio", () => ({ CallAudio: () => null }));
vi.mock("@/app/(app)/chat/recording-panel", () => ({ RecordingPanel: () => null }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/components/presence-store", () => ({ usePresenceRefresh: () => () => undefined }));
vi.mock("@/lib/call-sounds", () => ({ playCallSound: () => undefined }));

const { CallProvider, useCallHold } = await import("@/app/(app)/chat/call-session");

const SESSION: CallSession = {
    meetingId: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
    channelId: "019f8506-21f4-7173-a097-47c1fe63a88b",
    title: "Standup"
};

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    controls.toggleMic.mockClear();
    controls.toggleDeafen.mockClear();
});

afterEach(() => {
    cleanup();
});

describe("which key is which control", () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false, repeat: false };

    it("reads F9 as the microphone and F10 as deafen", () => {
        expect(callHotkey({ ...plain, key: "F9" })).toBe("mic");
        expect(callHotkey({ ...plain, key: "F10" })).toBe("deafen");
        expect(callHotkey({ ...plain, key: "F11" })).toBeNull();
    });

    it("leaves a chord and a held key alone", () => {
        expect(callHotkey({ ...plain, key: "F10", ctrlKey: true })).toBeNull();
        expect(callHotkey({ ...plain, key: "F10", altKey: true })).toBeNull();
        expect(callHotkey({ ...plain, key: "F10", metaKey: true })).toBeNull();
        expect(callHotkey({ ...plain, key: "F10", repeat: true })).toBeNull();
    });
});

describe("the binding", () => {
    it("toggles once per press and takes the key from the browser", () => {
        renderHook(() => useCallHotkeys(controls, true));
        const event = press("F10");
        expect(controls.toggleDeafen).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        press("F9");
        expect(controls.toggleMic).toHaveBeenCalledTimes(1);
    });

    it("does nothing while there is no call", () => {
        renderHook(() => useCallHotkeys(controls, false));
        const event = press("F10");
        expect(controls.toggleDeafen).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it("presses the controls the call has now, not the ones it started with", () => {
        const later = { toggleMic: vi.fn(), toggleDeafen: vi.fn() };
        const { rerender } = renderHook(({ call }) => useCallHotkeys(call, true), {
            initialProps: { call: controls }
        });
        rerender({ call: later });
        press("F10");
        expect(later.toggleDeafen).toHaveBeenCalledTimes(1);
        expect(controls.toggleDeafen).not.toHaveBeenCalled();
    });
});

describe("in the desktop app", () => {
    function installDesktop(held: { mic: boolean; deafen: boolean }) {
        let heard: ((which: "mic" | "deafen") => void) | null = null;
        const setCallHotkeys = vi.fn(async () => held);
        (window as { polarisDesktop?: unknown }).polarisDesktop = {
            version: "0.1.21",
            notify: async () => true,
            closeNotice: async () => undefined,
            pickFolder: async () => null,
            pushLocal: async () => ({ ok: true }),
            openWindow: async () => ({ ok: true }),
            setCallHotkeys,
            onCallHotkey: (listener: (which: "mic" | "deafen") => void) => {
                heard = listener;
                return () => {
                    heard = null;
                };
            }
        };
        return { setCallHotkeys, fire: (which: "mic" | "deafen") => heard?.(which) };
    }

    afterEach(() => {
        delete (window as { polarisDesktop?: unknown }).polarisDesktop;
    });

    it("hands the keys to the system for the call, and lets them go after", async () => {
        const desktop = installDesktop({ mic: true, deafen: true });
        const { unmount } = renderHook(() => useCallHotkeys(controls, true));
        expect(desktop.setCallHotkeys).toHaveBeenCalledWith({ mic: ["F9"], deafen: ["F10"] });
        await act(async () => undefined);
        // A press with another program in front reaches the call.
        desktop.fire("deafen");
        expect(controls.toggleDeafen).toHaveBeenCalledTimes(1);
        // The page does not toggle a second time for a key the system holds.
        press("F10");
        expect(controls.toggleDeafen).toHaveBeenCalledTimes(1);
        unmount();
        expect(desktop.setCallHotkeys).toHaveBeenLastCalledWith(null);
    });

    it("keeps listening itself for a key the system could not take", async () => {
        installDesktop({ mic: true, deafen: false });
        renderHook(() => useCallHotkeys(controls, true));
        await act(async () => undefined);
        press("F10");
        expect(controls.toggleDeafen).toHaveBeenCalledTimes(1);
        press("F9");
        expect(controls.toggleMic).not.toHaveBeenCalled();
    });
});

describe("the call's holder", () => {
    function EnterCall() {
        const { enter, leave } = useCallHold();
        return (
            <>
                <button type="button" onClick={() => enter(SESSION, false)}>
                    join
                </button>
                <button type="button" onClick={() => leave()}>
                    leave
                </button>
            </>
        );
    }

    it("deafens from any page while in a call, and stops when the call does", () => {
        render(
            <CallProvider viewerId="019f0000-0000-7000-8000-000000000001">
                <EnterCall />
            </CallProvider>
        );

        press("F10");
        expect(controls.toggleDeafen).not.toHaveBeenCalled();

        act(() => fireEvent.click(screen.getByText("join")));
        press("F10");
        expect(controls.toggleDeafen).toHaveBeenCalledTimes(1);

        act(() => fireEvent.click(screen.getByText("leave")));
        press("F10");
        expect(controls.toggleDeafen).toHaveBeenCalledTimes(1);
    });
});
