// @vitest-environment jsdom

/**
 * The Talk button over a camera: it asks for the microphone before the talk,
 * starts the talk, sends what the microphone heard to the talk route, and
 * closes both again. A Tapo added over RTSP gets a button that says what would
 * make it talk instead. The microphone and the audio graph are fakes: nothing
 * is recorded and nothing is played.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const TALK = "33333333-3333-4333-8333-333333333333";
const CAMERA = "11111111-1111-4111-8111-111111111111";

const startTalkAction = vi.fn(async (_camera: string) => ({ talkId: TALK }) as { talkId?: string; error?: string });
const stopTalkAction = vi.fn(async (_camera: string, _talk: string) => ({}));
vi.mock("@polaris-app/places/src/screens/actions", () => ({
    startTalkAction: (camera: string) => startTalkAction(camera),
    stopTalkAction: (camera: string, talk: string) => stopTalkAction(camera, talk)
}));

const { TalkControl } = await import("@polaris-app/places/src/screens/talk-control");

const trackStop = vi.fn();
let processor: { onaudioprocess: ((event: unknown) => void) | null } | null = null;
let contexts: FakeAudioContext[] = [];

class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createScriptProcessor() {
        processor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() } as never;
        return processor;
    }
    constructor() {
        contexts.push(this);
    }
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
}

let getUserMedia: ReturnType<typeof vi.fn>;
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 204 }));

beforeEach(() => {
    startTalkAction.mockClear();
    startTalkAction.mockImplementation(async () => ({ talkId: TALK }));
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    stopTalkAction.mockClear();
    trackStop.mockClear();
    fetchMock.mockClear();
    processor = null;
    contexts = [];
    getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

async function settle(ms = 0): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

describe("the Talk button", () => {
    it("asks for the microphone with echo cancelling, starts the talk, and sends what it hears", async () => {
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />));
        fireEvent.click(screen.getByRole("button", { name: "Talk" }));
        await settle();
        expect(getUserMedia).toHaveBeenCalledWith({
            audio: expect.objectContaining({ echoCancellation: true })
        });
        expect(startTalkAction).toHaveBeenCalledWith(CAMERA);
        const stop = screen.getByRole("button", { name: "Stop talking" });
        expect(stop.getAttribute("aria-pressed")).toBe("true");

        const frame = new Float32Array(4800);
        processor!.onaudioprocess!({
            inputBuffer: { getChannelData: () => frame },
            outputBuffer: { getChannelData: () => new Float32Array(4800) }
        });
        await settle(300);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`/api/home/cameras/${CAMERA}/talk?talk=${TALK}`);
        expect((init.body as ArrayBuffer).byteLength).toBe(1600);

        fireEvent.click(stop);
        await settle();
        expect(stopTalkAction).toHaveBeenCalledWith(CAMERA, TALK);
        expect(trackStop).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Talk" })).toBeTruthy();
    });

    it("opens the audio inside the press, before anything is awaited", () => {
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />));
        fireEvent.click(screen.getByRole("button", { name: "Talk" }));
        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.resume).toHaveBeenCalled();
    });

    it("keeps at most a second of voice waiting behind a stalled send", async () => {
        let release: () => void = () => undefined;
        fetchMock.mockImplementationOnce(
            () => new Promise<Response>((resolve) => (release = () => resolve(new Response(null, { status: 204 }))))
        );
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />));
        fireEvent.click(screen.getByRole("button", { name: "Talk" }));
        await settle();
        const frame = {
            inputBuffer: { getChannelData: () => new Float32Array(4800) },
            outputBuffer: { getChannelData: () => new Float32Array(4800) }
        };
        processor!.onaudioprocess!(frame);
        await settle(300);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
        for (let i = 0; i < 50; i++) processor!.onaudioprocess!(frame);
        release();
        await settle(1000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(((fetchMock.mock.calls[1]![1] as RequestInit).body as ArrayBuffer).byteLength).toBeLessThanOrEqual(16000);
        fireEvent.click(screen.getByRole("button", { name: "Stop talking" }));
    });

    it("starts no talk when the microphone is refused", async () => {
        getUserMedia.mockImplementation(async () => {
            throw new Error("NotAllowedError");
        });
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />));
        fireEvent.click(screen.getByRole("button", { name: "Talk" }));
        await settle();
        expect(startTalkAction).not.toHaveBeenCalled();
        expect(contexts[0]!.close).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Talk" })).toBeTruthy();
    });

    it("lets the microphone go when the talk is refused", async () => {
        startTalkAction.mockImplementation(async () => ({ error: "Somebody else is talking" }));
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />));
        fireEvent.click(screen.getByRole("button", { name: "Talk" }));
        await settle();
        expect(trackStop).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Talk" })).toBeTruthy();
    });

    it("stops on its own when the talk route says the talk is over", async () => {
        fetchMock.mockImplementation(async () => new Response(null, { status: 409 }));
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />));
        fireEvent.click(screen.getByRole("button", { name: "Talk" }));
        await settle();
        processor!.onaudioprocess!({
            inputBuffer: { getChannelData: () => new Float32Array(480) },
            outputBuffer: { getChannelData: () => new Float32Array(480) }
        });
        await settle(300);
        expect(screen.getByRole("button", { name: "Talk" })).toBeTruthy();
        expect(trackStop).toHaveBeenCalled();
    });

    it("tells a Tapo added over RTSP what makes it talk", () => {
        render(withMessages(<TalkControl cameraId={CAMERA} support="rtsp" />));
        expect(
            screen.getByRole("button", {
                name: "To talk through this camera, edit it and choose TP-Link Tapo (Tapo password)."
            })
        ).toBeTruthy();
    });

    it("says it in Spanish too", () => {
        render(withMessages(<TalkControl cameraId={CAMERA} support="yes" />, "es-ES"));
        expect(screen.getByRole("button", { name: "Hablar" })).toBeTruthy();
    });
});
