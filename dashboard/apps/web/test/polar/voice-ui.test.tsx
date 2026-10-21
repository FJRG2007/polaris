// @vitest-environment jsdom
/**
 * Polar's voice buttons and voice mode: available, unavailable (visible,
 * focusable, and saying what to connect) and a microphone the browser refused;
 * the call opens inline with its orb following the phases, mutes, ends on its
 * button or on Escape, and speaks with the browser's voice when no key can.
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
        null | ((file: File, sound: { durationMs: number; waveform: string }) => void)
};
let recordable = true;
let recordType: string | null = null;
let micLevel = 0;

vi.mock("@/app/(app)/chat/voice-recorder", () => ({
    canRecord: () => recordable,
    recordingType: () => recordType,
    spokenLength: (seconds: number) => `0:${String(seconds).padStart(2, "0")}`,
    useVoiceRecording: (
        onRecorded: (file: File, sound: { durationMs: number; waveform: string }) => void
    ) => {
        recorder.onRecorded = onRecorded;
        return recorder;
    }
}));

vi.mock("@/app/(app)/chat/voice-level", () => ({
    measureVoice: () => ({ read: () => micLevel, peak: () => 0, stop: () => undefined }),
    speaking: (level: number, threshold: number) => level >= threshold
}));

const { DictationButton, VoiceCall, VoiceModeButton } =
    await import("@/components/polar/polar-voice");

beforeEach(() => {
    recorder.recording = false;
    recorder.error = null;
    recorder.start.mockClear();
    recordable = true;
    recordType = null;
    micLevel = 0;
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
            name: "Speaking to Polar needs a speech-to-text key, like Groq or OpenAI."
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

    it("spends the key of whoever was picked to pay", async () => {
        const fetch = vi.fn(
            async () => new Response(JSON.stringify({ text: "hi" }), { status: 200 })
        );
        vi.stubGlobal("fetch", fetch);
        const onText = vi.fn();
        render(
            <DictationButton
                available
                payer="instance"
                onText={onText}
                onNotice={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        act(() =>
            recorder.onRecorded?.(
                new File([new Uint8Array([1])], "voice.webm", { type: "audio/webm" }),
                { durationMs: 900, waveform: "" }
            )
        );
        await waitFor(() => expect(onText).toHaveBeenCalledWith("hi"));
        expect(fetch.mock.calls[0]?.[0]).toBe(
            "/api/polar/transcribe?durationMs=900&payer=instance"
        );
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
                name: "Speaking to Polar needs a speech-to-text key, like Groq or OpenAI."
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

    const orb = () => document.querySelector("[data-state]")!.getAttribute("data-state");

    it("opens inline, listening, and explains a refused microphone", async () => {
        denyMicrophone();
        render(<VoiceCall {...props()} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("region", { name: "Voice mode" })).toBeTruthy();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByText("Listening")).toBeTruthy();
        expect((await screen.findByRole("alert")).textContent).toBe(
            "Polar can't use your microphone. Allow it for this site in your browser, then try again."
        );
        expect(orb()).toBe("error");
    });

    it("mutes and unmutes, from the button and from M", () => {
        denyMicrophone();
        render(<VoiceCall {...props()} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
        expect(screen.getByText("Microphone off")).toBeTruthy();
        expect(orb()).toBe("muted");
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
        fireEvent.keyDown(document.body, { key: "Escape" });
        expect(second.onEnd).toHaveBeenCalledTimes(1);
    });

    it("hears, thinks, and says the answer with the browser's voice when no key can", async () => {
        recordType = "audio/webm";
        vi.stubGlobal(
            "MediaRecorder",
            class {
                state = "inactive";
                ondataavailable: ((event: { data: Blob }) => void) | null = null;
                onstop: (() => void) | null = null;
                start() {
                    this.state = "recording";
                }
                stop() {
                    this.state = "inactive";
                    this.ondataavailable?.({ data: new Blob(["sound"]) });
                    this.onstop?.();
                }
            }
        );
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
                getUserMedia: vi.fn(async () => ({
                    getAudioTracks: () => [{}],
                    getTracks: () => []
                }))
            }
        });
        const fetched: string[] = [];
        const bodies: unknown[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                fetched.push(url);
                if (url.startsWith("/api/polar/transcribe")) {
                    return new Response(JSON.stringify({ text: "Hello" }), { status: 200 });
                }
                bodies.push(JSON.parse(String(init?.body)));
                return new Response(JSON.stringify({ error: "no_voice_provider" }), {
                    status: 409
                });
            })
        );
        type Said = { text: string; lang: string; onend: (() => void) | null };
        const said: Said[] = [];
        vi.stubGlobal(
            "SpeechSynthesisUtterance",
            class {
                lang = "";
                voice: unknown = null;
                onend: (() => void) | null = null;
                onerror: (() => void) | null = null;
                onboundary: (() => void) | null = null;
                constructor(public text: string) {}
            }
        );
        vi.stubGlobal("speechSynthesis", {
            getVoices: () => [{ lang: "en-US", default: true, name: "Fixture voice" }],
            speak: (utterance: Said) => said.push(utterance),
            cancel: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        });

        const base = props();
        const view = render(<VoiceCall {...base} />, { wrapper: MessagesWrapper });
        micLevel = 80;
        await waitFor(() => expect(orb()).toBe("hearing"), { timeout: 2000 });
        micLevel = 0;
        await waitFor(() => expect(base.onSend).toHaveBeenCalledWith("Hello"), {
            timeout: 4000
        });
        expect(orb()).toBe("thinking");

        view.rerender(
            <VoiceCall
                {...base}
                messages={[
                    { id: "u", role: "user", parts: [{ type: "text", text: "Hello" }] },
                    {
                        id: "a",
                        role: "assistant",
                        parts: [{ type: "text", text: "Hi there. How can I help?" }]
                    }
                ]}
                status="ready"
            />
        );
        await waitFor(() => expect(said).toHaveLength(1));
        expect(said[0]).toMatchObject({ text: "Hi there.", lang: "en-US" });
        expect(bodies[0]).toMatchObject({ text: "Hi there.", lang: "en-US" });
        expect(orb()).toBe("speaking");
        expect(screen.getByText("Speaking with your browser's voice")).toBeTruthy();
        act(() => said[0]!.onend?.());
        await waitFor(() => expect(said).toHaveLength(2));
        expect(said[1]!.text).toBe("How can I help?");
        act(() => said[1]!.onend?.());
        await waitFor(() => expect(orb()).toBe("listening"));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(fetched.filter((url) => url === "/api/polar/speak")).toHaveLength(2);
    }, 10_000);
});
