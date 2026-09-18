// @vitest-environment jsdom
/**
 * A stream's sound plays only while it is watched, at its own volume and mute,
 * and lowers the voices by the stream attenuation while it does.
 */

import { CallAudio } from "@/app/(app)/chat/call-audio";
import type { CallState } from "@/app/(app)/chat/call-state";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStreamMuted, setWatchedStreams } from "@/app/(app)/chat/call-stream-audio";

const volumes = new Map<string, number>();
vi.mock("@/app/(app)/chat/call-volumes", () => ({
    useCallVolume: (key: string) => [volumes.get(key) ?? 1, () => undefined]
}));
vi.mock("@/app/(app)/chat/call-boost", () => ({
    resumeBoost: () => undefined,
    boostStream: () => null
}));

const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key)
    }
});

const voice = { id: "voice", getAudioTracks: () => [{}] } as unknown as MediaStream;
const film = { id: "film", getAudioTracks: () => [{}] } as unknown as MediaStream;

function call(): CallState {
    return {
        meeting: {
            participants: [{ id: "p-bo", userId: "bo", name: "Bo", admission: "admitted" }]
        },
        participantId: "p-me",
        remote: new Map([["p-bo", voice]]),
        screens: new Map([["p-bo", film]]),
        states: new Map(),
        speaking: new Set(),
        deafened: false,
        audioRole: null
    } as unknown as CallState;
}

const elements = () => [...document.querySelectorAll("audio")];
const playing = (stream: MediaStream) => elements().find((element) => element.srcObject === stream);

beforeEach(() => {
    stored.clear();
    volumes.clear();
    setWatchedStreams([]);
    HTMLMediaElement.prototype.play = () => Promise.resolve();
});
afterEach(cleanup);

describe("a stream's sound", () => {
    it("is not played while nobody here is watching it", () => {
        render(<CallAudio call={call()} />);
        expect(playing(film)).toBeUndefined();
        expect(playing(voice)!.volume).toBe(1);
    });

    it("plays once watched, and lowers the voices by the attenuation", () => {
        render(<CallAudio call={call()} />);
        act(() => setWatchedStreams(["screen:p-bo"]));
        expect(playing(film)).toBeDefined();
        expect(playing(film)!.muted).toBe(false);
        expect(playing(voice)!.volume).toBeCloseTo(0.7);
    });

    it("is silenced by muting the stream, which gives the voices back", () => {
        render(<CallAudio call={call()} />);
        act(() => setWatchedStreams(["screen:p-bo"]));
        act(() => setStreamMuted("bo", true));
        expect(playing(film)!.muted).toBe(true);
        expect(playing(voice)!.volume).toBe(1);
    });

    it("is never started audible where it was muted before", () => {
        // What the mute was set to is read after mount, so a source attached in
        // the pass before that read is a film bursting out of a silent page.
        setStreamMuted("bo", true);
        const started: boolean[] = [];
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
            if (this.srcObject === film) started.push(this.muted);
            return Promise.resolve();
        };
        render(<CallAudio call={call()} />);
        act(() => setWatchedStreams(["screen:p-bo"]));
        expect(started.every((muted) => muted)).toBe(true);
        expect(playing(film)!.muted).toBe(true);
    });

    it("follows its own volume, not the sharer's voice", () => {
        volumes.set("stream:bo", 0.4);
        render(<CallAudio call={call()} />);
        act(() => setWatchedStreams(["screen:p-bo"]));
        expect(playing(film)!.volume).toBeCloseTo(0.4);
    });
});
