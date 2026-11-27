/**
 * Gemini Live as the second live voice provider: the ephemeral token minted
 * on the person's key (in the header only, never returned, the setup locked
 * whole), the PCM conversions the page carries audio with, reading the
 * route's grant, and the socket link - setup first, microphone audio out,
 * both transcripts in, barge-in emptying the player, and `ask_polar` answered
 * as a tool response.
 */

import { describe, expect, it } from "vitest";
import { readGrant } from "@/lib/polar/live-link";
import { ASK_POLAR_TOOL, type LiveEvent, type LiveGrant } from "@/lib/polar/live-voice";
import { GEMINI_LIVE_MODEL, GEMINI_TOKENS_URL, mintGeminiLiveToken } from "@/lib/polar/gemini-live";
import {
    GEMINI_LIVE_SOCKET,
    openGeminiLink,
    toolResponseBody,
    type LiveAudio,
    type LiveSocket
} from "@/lib/polar/gemini-live-link";
import {
    base64ToBytes,
    bytesToBase64,
    floatToPcm16,
    LIVE_INPUT_MIME,
    microphoneChunk,
    pcm16ToFloat,
    resample,
    voiceChunk
} from "@/lib/polar/pcm";

describe("mintGeminiLiveToken", () => {
    const NOW = Date.parse("2026-11-27T12:00:00Z");
    it("mints on the key in the header only and locks the whole setup", async () => {
        const sent: Array<{ url: string; init: RequestInit }> = [];
        const fake = (async (url: string, init: RequestInit) => {
            sent.push({ url, init });
            return new Response(JSON.stringify({ name: "auth_tokens/fixture-token" }), { status: 200 });
        }) as unknown as typeof fetch;
        const grant = await mintGeminiLiveToken({ apiKey: "AIza-fixture", lang: "es-ES", fetch: fake, now: () => NOW });
        expect(grant?.provider).toBe("google-ai");
        expect(grant?.token).toBe("auth_tokens/fixture-token");
        expect(JSON.stringify(grant)).not.toContain("AIza-fixture");
        expect(sent).toHaveLength(1);
        expect(sent[0]!.url).toBe(GEMINI_TOKENS_URL);
        expect(GEMINI_TOKENS_URL).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
        expect((sent[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-fixture");
        expect(String(sent[0]!.init.body)).not.toContain("AIza-fixture");
        const body = JSON.parse(String(sent[0]!.init.body));
        expect(body.uses).toBe(1);
        expect(Date.parse(body.newSessionExpireTime) - NOW).toBe(60_000);
        expect(Date.parse(body.expireTime) - NOW).toBe(30 * 60_000);
        // No fieldMask: every field of the setup is locked to the token.
        expect(body.fieldMask).toBeUndefined();
        const setup = body.bidiGenerateContentSetup;
        expect(setup).toEqual(grant?.setup);
        expect(setup.model).toBe(`models/${GEMINI_LIVE_MODEL}`);
        expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
        expect(setup.inputAudioTranscription).toEqual({});
        expect(setup.outputAudioTranscription).toEqual({});
        expect(setup.realtimeInputConfig.activityHandling).toBe("START_OF_ACTIVITY_INTERRUPTS");
        expect(setup.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name)).toEqual([ASK_POLAR_TOOL]);
        expect(setup.systemInstruction.parts[0].text).toContain("es-ES");
    });
    it("answers null when Google refuses, fails, or answers something else", async () => {
        const refuse = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
        expect(await mintGeminiLiveToken({ apiKey: "k", lang: null, fetch: refuse })).toBeNull();
        const odd = (async () => new Response(JSON.stringify({ name: "not-a-token" }), { status: 200 })) as unknown as typeof fetch;
        expect(await mintGeminiLiveToken({ apiKey: "k", lang: null, fetch: odd })).toBeNull();
        const down = (async () => {
            throw new TypeError("fetch failed");
        }) as unknown as typeof fetch;
        expect(await mintGeminiLiveToken({ apiKey: "k", lang: null, fetch: down })).toBeNull();
    });
});

describe("pcm", () => {
    it("resamples by linear interpolation to the asked length", () => {
        expect(Array.from(resample(new Float32Array([0, 1, 0, -1]), 16_000, 16_000))).toEqual([0, 1, 0, -1]);
        expect(Array.from(resample(new Float32Array([0, 1, 0, -1]), 16_000, 8_000))).toEqual([0, 0]);
        expect(Array.from(resample(new Float32Array([0, 1]), 8_000, 16_000))).toEqual([0, 0.5, 1, 1]);
        expect(resample(new Float32Array(48_000), 48_000, 16_000).length).toBe(16_000);
        expect(resample(new Float32Array(0), 48_000, 16_000).length).toBe(0);
    });
    it("writes 16-bit little-endian PCM, clipping out-of-range samples", () => {
        expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2, -2])))).toEqual([
            0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f, 0x00, 0x80
        ]);
    });
    it("reads PCM back, dropping a trailing odd byte", () => {
        expect(Array.from(pcm16ToFloat(new Uint8Array([0x00, 0x80, 0x00, 0x40, 0x01])))).toEqual([-1, 0.5]);
    });
    it("round-trips base64, and an invalid one is empty", () => {
        const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
        expect(base64ToBytes("%%%").length).toBe(0);
    });
    it("turns a 48 kHz microphone block into 16 kHz PCM, and 24 kHz voice into the context rate", () => {
        const block = new Float32Array(2048).fill(0.5);
        expect(base64ToBytes(microphoneChunk(block, 48_000)).length).toBe(Math.round(2048 / 3) * 2);
        const voice = bytesToBase64(floatToPcm16(new Float32Array(240).fill(0.25)));
        const played = voiceChunk(voice, 48_000);
        expect(played.length).toBe(480);
        expect(played[100]).toBeCloseTo(0.25, 3);
        expect(LIVE_INPUT_MIME).toBe("audio/pcm;rate=16000");
    });
});

describe("readGrant", () => {
    it("reads either provider, and an OpenAI answer that predates the field", () => {
        expect(readGrant({ value: "ek", expiresAt: 1 })).toEqual({ provider: "openai", value: "ek", expiresAt: 1 });
        expect(readGrant({ provider: "openai", value: "ek", expiresAt: 1 })?.provider).toBe("openai");
        expect(readGrant({ provider: "google-ai", token: "auth_tokens/x", setup: { model: "models/m" }, expiresAt: 1 })?.provider).toBe(
            "google-ai"
        );
    });
    it("refuses anything malformed", () => {
        for (const value of [null, "x", {}, { provider: "google-ai", token: "t", expiresAt: 1 }, { provider: "other", value: "v", expiresAt: 1 }]) {
            expect(readGrant(value)).toBeNull();
        }
    });
});

describe("toolResponseBody", () => {
    it("hands JSON objects over as objects, anything else wrapped", () => {
        expect(toolResponseBody(JSON.stringify({ answer: "Hi" }))).toEqual({ answer: "Hi" });
        expect(toolResponseBody("plain")).toEqual({ output: "plain" });
        expect(toolResponseBody("[1]")).toEqual({ output: "[1]" });
    });
});

type FakeSocket = {
    -readonly [K in keyof LiveSocket]: LiveSocket[K];
} & { url: string; sent: unknown[] };

function fakes() {
    const sockets: FakeSocket[] = [];
    const played: string[] = [];
    let cleared = 0;
    let chunk: ((data: string) => void) | null = null;
    const audio: LiveAudio = {
        onChunk: (listener) => {
            chunk = listener;
        },
        play: (data) => played.push(data),
        clear: () => {
            cleared += 1;
        },
        setMuted: () => undefined,
        level: () => 0,
        stop: () => undefined
    };
    const env = {
        socket: (url: string) => {
            const socket: FakeSocket = {
                url,
                sent: [],
                readyState: 1,
                onopen: null,
                onmessage: null,
                onclose: null,
                onerror: null,
                send(data: string) {
                    socket.sent.push(JSON.parse(data));
                },
                close() {
                    socket.readyState = 3;
                }
            };
            sockets.push(socket);
            return socket as LiveSocket;
        },
        audio: async () => audio
    };
    return {
        env,
        sockets,
        played,
        cleared: () => cleared,
        speak: (data: string) => chunk?.(data)
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const grant: Extract<LiveGrant, { provider: "google-ai" }> = {
    provider: "google-ai",
    token: "auth_tokens/fixture",
    setup: { model: "models/fixture" },
    expiresAt: 1
};

describe("openGeminiLink", () => {
    it("runs a call: setup, audio out, transcripts, barge-in, ask_polar", async () => {
        const world = fakes();
        const events: LiveEvent[] = [];
        const asked: string[] = [];
        const link = openGeminiLink(
            {
                grant,
                channel: {
                    mint: { url: "/unused", body: null },
                    runTool: async (call) => {
                        asked.push(call.arguments);
                        return JSON.stringify({ answer: "It is sunny." });
                    },
                    onLive: (event) => events.push(event)
                }
            },
            world.env
        );
        await flush();
        const socket = world.sockets[0]!;
        expect(socket.url).toBe(`${GEMINI_LIVE_SOCKET}?access_token=auth_tokens%2Ffixture`);
        socket.onopen?.({});
        expect(socket.sent[0]).toEqual({ setup: { model: "models/fixture" } });
        // Nothing is sent before the server has taken the setup.
        world.speak("AAAA");
        expect(socket.sent).toHaveLength(1);
        const server = async (message: unknown) => {
            socket.onmessage?.({ data: JSON.stringify(message) });
            await flush();
        };
        await server({ setupComplete: {} });
        expect(link.snapshot().phase).toBe("live");
        world.speak("AAAA");
        expect(socket.sent[1]).toEqual({ realtimeInput: { audio: { data: "AAAA", mimeType: LIVE_INPUT_MIME } } });

        await server({ serverContent: { inputTranscription: { text: "Hello" } } });
        await server({ serverContent: { inputTranscription: { text: " there" } } });
        expect(link.snapshot().heard).toBe("Hello there");
        await server({
            serverContent: {
                outputTranscription: { text: "Hi!" },
                modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "BBBB" } }] }
            }
        });
        expect(world.played).toEqual(["BBBB"]);
        expect(link.snapshot().caption).toBe("Hi!");
        // Talked over: the queue is emptied and what was said so far is the reply.
        await server({ serverContent: { interrupted: true } });
        expect(world.cleared()).toBe(1);
        expect(events).toEqual([
            { type: "heard", text: "Hello there" },
            { type: "said", text: "Hi!", via: "direct" }
        ]);

        events.length = 0;
        await server({ serverContent: { inputTranscription: { text: "Weather?" } } });
        await server({ toolCall: { functionCalls: [{ id: "c1", name: ASK_POLAR_TOOL, args: { request: "Weather?" } }] } });
        await flush();
        expect(asked).toEqual([JSON.stringify({ request: "Weather?" })]);
        expect(socket.sent.at(-1)).toEqual({
            toolResponse: { functionResponses: [{ id: "c1", name: ASK_POLAR_TOOL, response: { answer: "It is sunny." } }] }
        });
        await server({ serverContent: { outputTranscription: { text: "Sunny." }, turnComplete: true } });
        expect(events).toEqual([
            { type: "heard", text: "Weather?" },
            { type: "said", text: "", via: "call" },
            { type: "said", text: "Sunny.", via: "reading" }
        ]);
        link.close();
        expect(link.snapshot().phase).toBe("closed");
    });

    it("does not answer a cancelled call, and fails when the socket drops before it is live", async () => {
        const world = fakes();
        let release: (value: string) => void = () => undefined;
        const link = openGeminiLink(
            {
                grant,
                channel: {
                    mint: { url: "/unused", body: null },
                    runTool: () => new Promise<string>((resolve) => (release = resolve))
                }
            },
            world.env
        );
        await flush();
        const socket = world.sockets[0]!;
        socket.onopen?.({});
        socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
        await flush();
        socket.onmessage?.({ data: JSON.stringify({ toolCall: { functionCalls: [{ id: "c9", name: ASK_POLAR_TOOL, args: {} }] } }) });
        await flush();
        socket.onmessage?.({ data: JSON.stringify({ toolCallCancellation: { ids: ["c9"] } }) });
        await flush();
        release(JSON.stringify({ answer: "late" }));
        await flush();
        expect(socket.sent.some((message) => "toolResponse" in (message as object))).toBe(false);
        link.close();

        const second = fakes();
        const dropped = openGeminiLink({ grant, channel: { mint: { url: "/unused", body: null }, runTool: async () => "" } }, second.env);
        await flush();
        second.sockets[0]!.onclose?.({});
        expect(dropped.snapshot()).toMatchObject({ phase: "failed", error: "failed" });
    });

    it("reconnects on its resumption handle when the server goes away", async () => {
        const world = fakes();
        const link = openGeminiLink({ grant, channel: { mint: { url: "/unused", body: null }, runTool: async () => "" } }, world.env);
        await flush();
        const first = world.sockets[0]!;
        first.onopen?.({});
        first.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
        await flush();
        first.onmessage?.({ data: JSON.stringify({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } }) });
        await flush();
        first.onclose?.({});
        const second = world.sockets[1]!;
        second.onopen?.({});
        expect(second.sent[0]).toEqual({ setup: { model: "models/fixture", sessionResumption: { handle: "h1" } } });
        expect(link.snapshot().phase).toBe("live");
        link.close();
    });

    it("says the microphone was refused", async () => {
        const link = openGeminiLink(
            { grant, channel: { mint: { url: "/unused", body: null }, runTool: async () => "" } },
            {
                socket: () => {
                    throw new Error("not opened");
                },
                audio: async () => {
                    throw new DOMException("denied", "NotAllowedError");
                }
            }
        );
        await flush();
        expect(link.snapshot()).toMatchObject({ phase: "failed", error: "mic_denied" });
    });
});
