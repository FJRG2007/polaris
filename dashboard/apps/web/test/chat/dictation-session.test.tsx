// @vitest-environment jsdom

/**
 * The lifecycle of a dictation session and of a held voice message: words that
 * arrive after the box was emptied or the conversation changed are dropped, a
 * refusal from Polaris ends the session instead of leaving the microphone on,
 * a missing microphone is not reported as a blocked one, and a hold let go of
 * before the microphone opened never turns into a recording.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcribe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/polar/transcribe-audio", () => ({ transcribeAudio: transcribe }));
vi.mock("@/app/(app)/chat/voice-level", () => ({
    measureVoice: () => ({ read: () => level.value, stop: () => undefined })
}));
vi.mock("@/app/(app)/chat/mic-filter", () => ({ filterMic: async () => null }));

const level = vi.hoisted(() => ({ value: 0 }));

const { useDictation } = await import("@/app/(app)/chat/use-dictation");
const { useVoiceRecording } = await import("@/app/(app)/chat/voice-recorder");

class FakeRecognizer {
    static last: FakeRecognizer | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    onsoundstart: (() => void) | null = null;
    onsoundend: (() => void) | null = null;
    aborted = false;
    constructor() {
        FakeRecognizer.last = this;
    }
    start() {}
    stop() {}
    abort() {
        this.aborted = true;
    }
    say(text: string) {
        this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
    }
}

let recorders = 0;
class FakeMediaRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    stream: MediaStream;
    constructor(stream: MediaStream) {
        recorders++;
        this.stream = stream;
    }
    start() {
        this.state = "recording";
    }
    stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["sound"]) });
        this.onstop?.();
    }
}

function fakeStream() {
    const track = { stop: vi.fn(), kind: "audio" };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    return { stream, track };
}

function micAnswers(answer: () => Promise<MediaStream>) {
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: vi.fn(answer) }
    });
}

beforeEach(() => {
    recorders = 0;
    level.value = 0;
    transcribe.mockReset();
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognizer;
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("browser dictation", () => {
    it("still hands over the last words after a stop", () => {
        const onText = vi.fn();
        const { result } = renderHook(() => useDictation({ engine: "browser", locale: "en-US", onText }));
        act(() => result.current.start());
        const recognizer = FakeRecognizer.last!;
        act(() => result.current.stop());
        act(() => recognizer.say("last words"));
        expect(onText).toHaveBeenCalledWith("last words");
    });

    it("drops what arrives after a cancel, even after a stop", () => {
        const onText = vi.fn();
        const { result } = renderHook(() => useDictation({ engine: "browser", locale: "en-US", onText }));
        act(() => result.current.start());
        const recognizer = FakeRecognizer.last!;
        act(() => result.current.stop());
        act(() => result.current.cancel());
        act(() => recognizer.say("for the other conversation"));
        expect(onText).not.toHaveBeenCalled();
        expect(recognizer.aborted).toBe(true);
        expect(result.current.active).toBe(false);
    });
});

describe("private dictation", () => {
    async function speakOneChunk() {
        level.value = 80;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(200);
        });
        level.value = 0;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1200);
        });
    }

    it("ends the session when Polaris refuses", async () => {
        vi.useFakeTimers();
        const { stream, track } = fakeStream();
        micAnswers(async () => stream);
        transcribe.mockResolvedValue({ error: "rate_limited" });
        const { result } = renderHook(() =>
            useDictation({ engine: "private", locale: "en-US", onText: () => undefined })
        );
        await act(async () => result.current.start());
        await speakOneChunk();
        expect(transcribe).toHaveBeenCalled();
        expect(result.current.problem).toBe("tooMany");
        expect(result.current.active).toBe(false);
        expect(track.stop).toHaveBeenCalled();
        const sent = transcribe.mock.calls.length;
        level.value = 80;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
        });
        expect(transcribe.mock.calls.length).toBe(sent);
    });

    it("drops a chunk still on its way when cancelled", async () => {
        vi.useFakeTimers();
        const { stream } = fakeStream();
        micAnswers(async () => stream);
        let answer: (value: { text: string }) => void = () => undefined;
        transcribe.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
        const onText = vi.fn();
        const { result } = renderHook(() => useDictation({ engine: "private", locale: "en-US", onText }));
        await act(async () => result.current.start());
        await speakOneChunk();
        act(() => result.current.cancel());
        await act(async () => answer({ text: "too late" }));
        expect(onText).not.toHaveBeenCalled();
    });

    it("says no microphone, not blocked, when there is none", async () => {
        micAnswers(async () => {
            throw new DOMException("none", "NotFoundError");
        });
        const { result } = renderHook(() =>
            useDictation({ engine: "private", locale: "en-US", onText: () => undefined })
        );
        await act(async () => result.current.start());
        expect(result.current.problem).toBe("noMic");
    });

    it("says blocked when permission is refused", async () => {
        micAnswers(async () => {
            throw new DOMException("no", "NotAllowedError");
        });
        const { result } = renderHook(() =>
            useDictation({ engine: "private", locale: "en-US", onText: () => undefined })
        );
        await act(async () => result.current.start());
        expect(result.current.problem).toBe("micBlocked");
    });
});

describe("a held voice message", () => {
    it("is never recorded when let go of before the microphone opens", async () => {
        const { stream, track } = fakeStream();
        let open: (value: MediaStream) => void = () => undefined;
        micAnswers(() => new Promise((resolve) => (open = resolve)));
        const recorded = vi.fn();
        const { result } = renderHook(() => useVoiceRecording(recorded));
        act(() => result.current.start());
        act(() => result.current.cancel());
        await act(async () => open(stream));
        expect(recorders).toBe(0);
        expect(track.stop).toHaveBeenCalled();
        expect(result.current.recording).toBe(false);
        expect(recorded).not.toHaveBeenCalled();
    });
});
