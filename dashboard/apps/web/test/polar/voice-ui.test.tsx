// @vitest-environment jsdom
/**
 * Polar's voice buttons and the voice-mode overlay: available, unavailable
 * (visible, focusable, and saying what to connect) and a microphone the
 * browser refused; the overlay opens on the thread, mutes, and ends on its
 * button or on Escape.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const recorder = {
    recording: false,
    seconds: 0,
    levels: [] as number[],
    silent: false,
    error: null as string | null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    onRecorded: null as
        | null
        | ((file: File, sound: { durationMs: number; waveform: string }) => void)
};
let recordable = true;

vi.mock("@/app/(app)/chat/voice-recorder", () => ({
    canRecord: () => recordable,
    recordingType: () => null,
    spokenLength: (seconds: number) => `0:${String(seconds).padStart(2, "0")}`,
    useVoiceRecording: (
        onRecorded: (file: File, sound: { durationMs: number; waveform: string }) => void
    ) => {
        recorder.onRecorded = onRecorded;
        return recorder;
    }
}));

const { DictationButton, VoiceCall, VoiceModeButton } = await import(
    "@/components/polar/polar-voice"
);

beforeEach(() => {
    recorder.recording = false;
    recorder.error = null;
    recorder.start.mockClear();
    recordable = true;
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the dictation button", () => {
    it("records when a voice provider is connected", () => {
        const onNotice = vi.fn();
        render(<DictationButton available onText={() => undefined} onNotice={onNotice} />, {
            wrapper: MessagesWrapper
        });
        const button = screen.getByRole("button", { name: "Dictate" });
        expect(button.getAttribute("aria-disabled")).toBeNull();
        fireEvent.click(button);
        expect(recorder.start).toHaveBeenCalledTimes(1);
        expect(onNotice).toHaveBeenCalledWith(null);
    });

    it("stays visible without a provider and says what to connect", () => {
        const onNotice = vi.fn();
        render(<DictationButton available={false} onText={() => undefined} onNotice={onNotice} />, {
            wrapper: MessagesWrapper
        });
        const button = screen.getByRole("button", {
            name: "Speaking to Polar needs an OpenAI or Google AI key."
        });
        expect(button.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(button);
        expect(recorder.start).not.toHaveBeenCalled();
        expect(onNotice).toHaveBeenCalledWith("unavailable");
    });

    it("says so when the browser cannot record", () => {
        recordable = false;
        const onNotice = vi.fn();
        render(<DictationButton available onText={() => undefined} onNotice={onNotice} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
        expect(onNotice).toHaveBeenCalledWith("cannotRecord");
    });

    it("reports a microphone the browser refused", () => {
        recorder.error = "Polaris could not reach your microphone.";
        const onNotice = vi.fn();
        render(<DictationButton available onText={() => undefined} onNotice={onNotice} />, {
            wrapper: MessagesWrapper
        });
        expect(onNotice).toHaveBeenCalledWith("micDenied");
    });

    it("shows stop and discard while recording", () => {
        recorder.recording = true;
        recorder.seconds = 4;
        render(<DictationButton available onText={() => undefined} onNotice={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Recording 0:04")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Stop and transcribe" }));
        expect(recorder.stop).toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
        expect(recorder.cancel).toHaveBeenCalled();
    });

    it("puts the transcription in the composer's hands", async () => {
        const fetched: Array<{ url: string; type: string | null }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: RequestInit) => {
                fetched.push({
                    url,
                    type: new Headers(init.headers).get("content-type")
                });
                return new Response(JSON.stringify({ text: "remind me at five" }), { status: 200 });
            })
        );
        const onText = vi.fn();
        render(<DictationButton available onText={onText} onNotice={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        act(() =>
            recorder.onRecorded?.(
                new File([new Uint8Array([1])], "voice.webm", { type: "audio/webm" }),
                {
                    durationMs: 1800,
                    waveform: ""
                }
            )
        );
        await waitFor(() => expect(onText).toHaveBeenCalledWith("remind me at five"));
        expect(fetched[0]).toEqual({
            url: "/api/polar/transcribe?durationMs=1800",
            type: "audio/webm"
        });
    });
});

describe("the voice mode button", () => {
    it("opens the call, or says what to connect", () => {
        const onOpen = vi.fn();
        const onNotice = vi.fn();
        const { rerender } = render(
            <VoiceModeButton available onOpen={onOpen} onNotice={onNotice} />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Voice mode" }));
        expect(onOpen).toHaveBeenCalledTimes(1);
        rerender(<VoiceModeButton available={false} onOpen={onOpen} onNotice={onNotice} />);
        fireEvent.click(
            screen.getByRole("button", {
                name: "Speaking to Polar needs an OpenAI or Google AI key."
            })
        );
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onNotice).toHaveBeenLastCalledWith("unavailable");
    });
});

describe("the voice call", () => {
    const props = () => ({
        messages: [],
        status: "ready" as const,
        speech: true,
        tools: {},
        onSend: vi.fn(),
        onStop: vi.fn(),
        onApprove: vi.fn(),
        onEnd: vi.fn()
    });

    function denyMicrophone() {
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) }
        });
    }

    it("opens listening, and explains a refused microphone", async () => {
        denyMicrophone();
        render(<VoiceCall {...props()} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("dialog", { name: "Voice mode" })).toBeTruthy();
        expect(screen.getByText("Listening")).toBeTruthy();
        expect((await screen.findByRole("alert")).textContent).toBe(
            "Polar can't use your microphone. Allow it for this site in your browser, then try again."
        );
    });

    it("mutes and unmutes, from the button and from M", () => {
        denyMicrophone();
        render(<VoiceCall {...props()} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
        expect(screen.getByText("Microphone off")).toBeTruthy();
        const unmute = screen.getByRole("button", { name: "Turn microphone on" });
        expect(unmute.getAttribute("aria-pressed")).toBe("true");
        fireEvent.keyDown(unmute, { key: "m" });
        expect(screen.getByRole("button", { name: "Mute microphone" })).toBeTruthy();
    });

    it("ends on its button and on Escape", () => {
        denyMicrophone();
        const first = props();
        render(<VoiceCall {...first} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "End call" }));
        expect(first.onEnd).toHaveBeenCalledTimes(1);
        cleanup();
        const second = props();
        render(<VoiceCall {...second} />, { wrapper: MessagesWrapper });
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(second.onEnd).toHaveBeenCalledTimes(1);
    });
});
