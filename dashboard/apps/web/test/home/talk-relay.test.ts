/**
 * What talking through a camera asks of the relay (go2rtc 1.9.14): a stream to
 * push into, the push itself with no deadline on its answer, the camera pointed
 * at that stream over the relay's own loopback RTSP, and the way back out.
 * Plus telling a relay from before talking apart from one that has it, and the
 * browser's microphone brought down to the talk rate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    endTalk,
    playTalk,
    prepareTalk,
    pushTalk,
    talkPlayQuery,
    talkReadiness,
    type RelayEndpoint
} from "@polaris-app/places/src/lib/relay";
import { talkSupport } from "@polaris-app/places/src/lib/vendors";
import { TALK_RATE, TalkResampler } from "@polaris-app/places/src/lib/talk-audio";

const ENDPOINT = {
    installedAppId: "relay-fixture",
    baseUrl: "http://relay.invalid:1984",
    username: "polaris",
    password: "fixture-password"
} as unknown as RelayEndpoint;

type Call = { method: string; url: URL; init: RequestInit & { duplex?: string } };

function record(answer: () => Response = () => new Response("{}")): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ method: init.method ?? "GET", url: new URL(url), init });
            return answer();
        })
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("the talk requests", () => {
    it("readies a talk stream with a source nothing answers at", async () => {
        const calls = record();
        await prepareTalk(ENDPOINT, "cam1");
        expect(calls[0]!.method).toBe("PUT");
        expect(calls[0]!.url.pathname).toBe("/api/streams");
        expect(calls[0]!.url.searchParams.get("name")).toBe("cam1-talk");
        expect(calls[0]!.url.searchParams.get("src")).toBe("tcp://127.0.0.1:1");
    });

    it("refuses when the relay will not make the stream", async () => {
        record(() => new Response("bad", { status: 400 }));
        await expect(prepareTalk(ENDPOINT, "cam1")).rejects.toThrow(
            "The camera relay would not take a voice"
        );
    });

    it("pushes a streaming body to /api/stream and never times the answer out", async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string, init: RequestInit & { duplex?: string }) => {
                const parsed = new URL(url);
                expect(init.method).toBe("POST");
                expect(parsed.pathname).toBe("/api/stream");
                expect(parsed.searchParams.get("dst")).toBe("cam1-talk");
                expect(init.duplex).toBe("half");
                expect(init.body).toBeInstanceOf(ReadableStream);
                expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
                signal = init.signal ?? undefined;
                return new Promise<Response>(() => undefined);
            })
        );
        const stop = new AbortController();
        void pushTalk(ENDPOINT, "cam1", new ReadableStream<Uint8Array>(), stop.signal);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(signal?.aborted).toBe(false);
        stop.abort();
        expect(signal?.aborted).toBe(true);
    });

    it("points the camera's main stream at the talk stream over loopback RTSP", async () => {
        const calls = record();
        expect(await playTalk(ENDPOINT, "cam1")).toBe(true);
        expect(calls[0]!.method).toBe("POST");
        expect(calls[0]!.url.searchParams.get("dst")).toBe("cam1-main");
        expect(calls[0]!.url.searchParams.get("src")).toBe(
            "rtsp://127.0.0.1:8554/cam1-talk?audio=pcma"
        );
        expect(talkPlayQuery("cam1", false)).toBe("dst=cam1-main&src=");
    });

    it("reads a refused play as false rather than throwing", async () => {
        record(() => new Response("no", { status: 500 }));
        expect(await playTalk(ENDPOINT, "cam1")).toBe(false);
    });

    it("stops the speaker, then forgets the talk stream", async () => {
        const calls = record();
        await endTalk(ENDPOINT, "cam1");
        expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
        expect(calls[0]!.url.searchParams.get("src")).toBe("");
        expect(calls[1]!.url.searchParams.get("src")).toBe("cam1-talk");
    });
});

describe("whether a relay can take a voice", () => {
    it("knows a relay from before talking by the web server's own 404", async () => {
        record(() => new Response("404 page not found\n", { status: 404 }));
        expect(await talkReadiness(ENDPOINT)).toBe("outdated");
    });

    it("knows one that has it by go2rtc's own answer", async () => {
        record(() => new Response("stream not found\n", { status: 404 }));
        expect(await talkReadiness(ENDPOINT)).toBe("ready");
    });

    it("says when it did not answer", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("refused");
            })
        );
        expect(await talkReadiness(ENDPOINT)).toBe("unreachable");
    });
});

describe("which cameras can talk", () => {
    it("is a Tapo over its own protocol, and only that", () => {
        expect(talkSupport("tapo-cloud")).toBe("yes");
        expect(talkSupport("tapo-battery")).toBe("yes");
        expect(talkSupport("tapo")).toBe("rtsp");
        expect(talkSupport("reolink")).toBe("no");
    });
});

describe("the microphone at the talk rate", () => {
    it("averages 48 kHz down to 8 kHz", () => {
        const resampler = new TalkResampler(48_000);
        const input = new Float32Array(4800).fill(0.5);
        const out = resampler.push(input);
        expect(out.byteLength).toBe(800 * 2);
        expect(new DataView(out.buffer, out.byteOffset).getInt16(0, true)).toBe(
            Math.round(0.5 * 32767)
        );
    });

    it("carries 44.1 kHz's remainder across pieces instead of losing it", () => {
        const resampler = new TalkResampler(44_100);
        let samples = 0;
        for (let i = 0; i < 10; i++)
            samples += resampler.push(new Float32Array(4410)).byteLength / 2;
        // A second of input is the talk rate's second of output, give or take one.
        expect(Math.abs(samples - TALK_RATE)).toBeLessThanOrEqual(1);
    });

    it("clips what is louder than full scale", () => {
        const out = new TalkResampler(TALK_RATE).push(new Float32Array([2, -2]));
        const view = new DataView(out.buffer, out.byteOffset);
        expect(view.getInt16(0, true)).toBe(32767);
        expect(view.getInt16(2, true)).toBe(-32767);
    });
});
