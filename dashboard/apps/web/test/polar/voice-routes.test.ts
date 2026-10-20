/**
 * The two voice routes: what a transcription and a spoken sentence take, what
 * they refuse, and that without an OpenAI or Google key they say so instead of
 * failing. Plus the availability the models route carries for the buttons.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";

const state = {
    user: { id: OWNER, viewingAs: null as string | null } as {
        id: string;
        viewingAs: string | null;
    } | null,
    limited: false,
    provider: true,
    transcribed: [] as Array<{ audio: Uint8Array }>,
    spoken: [] as Array<{ text: string; voice: string; outputFormat: string }>,
    fail: false,
    payers: [] as Array<string | null>
};

vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user
            ? { ...state.user, isAdmin: false, name: "Ada" }
            : NextResponse.json({ error: "unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !state.limited })
}));
vi.mock("@/lib/polar/voice", () => ({
    polarTranscriber: async (_userId: string, payer: string | null) => {
        state.payers.push(payer);
        return state.provider ? { kind: "transcriber" } : null;
    },
    polarSpeaker: async (_userId: string, payer: string | null) => {
        state.payers.push(payer);
        return state.provider
            ? { model: { kind: "speaker" }, voice: "alloy", format: "mp3", mediaType: "audio/mpeg" }
            : null;
    },
    polarVoiceAvailability: async () => ({ dictation: state.provider, speech: state.provider })
}));
vi.mock("ai", () => ({
    experimental_transcribe: async (options: { audio: Uint8Array }) => {
        if (state.fail) throw new Error("provider said no");
        state.transcribed.push(options);
        return { text: "  hello polar  " };
    },
    experimental_generateSpeech: async (options: {
        text: string;
        voice: string;
        outputFormat: string;
    }) => {
        if (state.fail) throw new Error("provider said no");
        state.spoken.push(options);
        return { audio: { uint8Array: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" } };
    }
}));
vi.mock("@/lib/polar/models", () => ({ polarModelOptions: async () => [] }));
vi.mock("@/lib/polar/tools", () => ({ polarTools: async () => ({ described: {} }) }));

const transcribeRoute = await import("@/app/api/polar/transcribe/route");
const speakRoute = await import("@/app/api/polar/speak/route");
const modelsRoute = await import("@/app/api/polar/models/route");

function recording(
    body: BodyInit | null = new Uint8Array([26, 69, 223, 163]),
    type = "audio/webm;codecs=opus",
    query = "durationMs=1200"
): Request {
    return new Request(`http://polaris.test/api/polar/transcribe?${query}`, {
        method: "POST",
        headers: { "content-type": type },
        body
    });
}

function sentence(body: unknown): Request {
    return new Request("http://polaris.test/api/polar/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.limited = false;
    state.provider = true;
    state.transcribed = [];
    state.spoken = [];
    state.fail = false;
    state.payers = [];
});

describe("POST /api/polar/transcribe", () => {
    it("answers the text of a recording", async () => {
        const response = await transcribeRoute.POST(recording());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ text: "hello polar" });
        expect(state.transcribed[0]?.audio).toEqual(new Uint8Array([26, 69, 223, 163]));
        expect(state.payers).toEqual([null]);
    });

    it("spends the key of whoever was picked to pay, and refuses an unknown payer", async () => {
        const query = "durationMs=1200&payer=instance";
        expect((await transcribeRoute.POST(recording(undefined, undefined, query))).status).toBe(
            200
        );
        expect(state.payers).toEqual(["instance"]);
        const unknown = "durationMs=1200&payer=someone";
        expect((await transcribeRoute.POST(recording(undefined, undefined, unknown))).status).toBe(
            400
        );
        expect(state.payers).toEqual(["instance"]);
    });

    it("refuses anybody signed out, or viewing as somebody else", async () => {
        state.user = null;
        expect((await transcribeRoute.POST(recording())).status).toBe(401);
        state.user = { id: OWNER, viewingAs: "someone" };
        expect((await transcribeRoute.POST(recording())).status).toBe(403);
    });

    it("is rate limited per person", async () => {
        state.limited = true;
        const response = await transcribeRoute.POST(recording());
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: "rate_limited" });
    });

    it("refuses what is not a recording, an empty one, and one claimed too long", async () => {
        expect((await transcribeRoute.POST(recording(undefined, "image/png"))).status).toBe(415);
        expect((await transcribeRoute.POST(recording(new Uint8Array(0)))).status).toBe(400);
        expect(
            (await transcribeRoute.POST(recording(undefined, undefined, "durationMs=300001")))
                .status
        ).toBe(400);
        expect((await transcribeRoute.POST(recording(undefined, undefined, ""))).status).toBe(400);
        expect(state.transcribed).toHaveLength(0);
    });

    it("refuses a recording bigger than the cap", async () => {
        const big = new Uint8Array(8 * 1024 * 1024 + 1);
        const response = await transcribeRoute.POST(recording(big));
        expect(response.status).toBe(413);
        expect(state.transcribed).toHaveLength(0);
    });

    it("says there is no voice provider instead of failing", async () => {
        state.provider = false;
        const response = await transcribeRoute.POST(recording());
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "no_voice_provider" });
    });

    it("hides the provider's own error", async () => {
        state.fail = true;
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const response = await transcribeRoute.POST(recording());
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "transcribe_failed" });
        spy.mockRestore();
    });
});

describe("POST /api/polar/speak", () => {
    it("answers the audio of one sentence in the provider's voice", async () => {
        const response = await speakRoute.POST(sentence({ text: "  Two meetings today.  " }));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("audio/mpeg");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(state.spoken[0]).toMatchObject({
            text: "Two meetings today.",
            voice: "alloy",
            outputFormat: "mp3"
        });
        expect(state.payers).toEqual([null]);
    });

    it("spends the key of whoever was picked to pay", async () => {
        const response = await speakRoute.POST(sentence({ text: "Hi.", payer: "own" }));
        expect(response.status).toBe(200);
        expect(state.payers).toEqual(["own"]);
        expect((await speakRoute.POST(sentence({ text: "Hi.", payer: "boss" }))).status).toBe(400);
    });

    it("refuses an empty, an unreadable and an over-long text", async () => {
        expect((await speakRoute.POST(sentence({ text: "   " }))).status).toBe(400);
        expect((await speakRoute.POST(sentence("{not json"))).status).toBe(400);
        expect((await speakRoute.POST(sentence({ text: "a".repeat(601) }))).status).toBe(400);
        expect((await speakRoute.POST(sentence({ words: "hi" }))).status).toBe(400);
        expect(state.spoken).toHaveLength(0);
    });

    it("is rate limited, and refuses view-as", async () => {
        state.limited = true;
        expect((await speakRoute.POST(sentence({ text: "Hi." }))).status).toBe(429);
        state.limited = false;
        state.user = { id: OWNER, viewingAs: "someone" };
        expect((await speakRoute.POST(sentence({ text: "Hi." }))).status).toBe(403);
    });

    it("says there is no voice provider", async () => {
        state.provider = false;
        const response = await speakRoute.POST(sentence({ text: "Hi." }));
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "no_voice_provider" });
    });

    it("hides the provider's own error", async () => {
        state.fail = true;
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const response = await speakRoute.POST(sentence({ text: "Hi." }));
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "speak_failed" });
        spy.mockRestore();
    });
});

describe("GET /api/polar/models", () => {
    it("carries whether this person can use their voice", async () => {
        expect((await (await modelsRoute.GET()).json()).voice).toEqual({
            dictation: true,
            speech: true
        });
        state.provider = false;
        expect((await (await modelsRoute.GET()).json()).voice).toEqual({
            dictation: false,
            speech: false
        });
    });
});
