/**
 * Live voice in a Polar chat: which provider a call runs on (a key of the
 * person's own only), which mode the call opens in (the fallback label's
 * input), how what was heard and said pairs into saved exchanges, and the
 * secret minted for it - the key in the request header only, never returned.
 */

import { describe, expect, it } from "vitest";
import { mintLiveSecret, LIVE_TRANSCRIBE_MODEL } from "@/lib/polar/voice-realtime";
import {
    ASK_POLAR_TOOL,
    EMPTY_LEDGER,
    ledgerStep,
    liveTurnBodySchema,
    liveVoiceProvider,
    voiceModeOf,
    type LiveEvent,
    type LiveLedger
} from "@/lib/polar/live-voice";

describe("liveVoiceProvider", () => {
    it("picks OpenAI on a key of the person's own", () => {
        expect(liveVoiceProvider(new Map([["openai", "own"]]))).toBe("openai");
    });
    it("never the deployment's key", () => {
        expect(liveVoiceProvider(new Map([["openai", "instance"]]))).toBeNull();
    });
    it("none without a live-capable provider", () => {
        expect(liveVoiceProvider(new Map([["groq", "own"], ["anthropic", "own"]]))).toBeNull();
        expect(liveVoiceProvider(new Map())).toBeNull();
    });
});

describe("voiceModeOf", () => {
    it("is live when a live provider is held, transcription or not", () => {
        expect(voiceModeOf({ dictation: true, realtime: true })).toBe("live");
        expect(voiceModeOf({ dictation: false, realtime: true })).toBe("live");
    });
    it("falls back to transcription when only speech to text is held", () => {
        expect(voiceModeOf({ dictation: true, realtime: false })).toBe("transcribed");
        expect(voiceModeOf({ dictation: true })).toBe("transcribed");
    });
    it("is none with neither", () => {
        expect(voiceModeOf({ dictation: false })).toBe("none");
    });
});

function run(events: LiveEvent[]) {
    let ledger: LiveLedger = EMPTY_LEDGER;
    const saved: Array<{ user: string; assistant: string }> = [];
    for (const event of events) {
        const step = ledgerStep(ledger, event);
        ledger = step.ledger;
        if (step.exchange) saved.push(step.exchange);
    }
    return saved;
}

describe("ledgerStep", () => {
    it("pairs what was heard with the reply", () => {
        expect(
            run([
                { type: "heard", text: "What time is it in Tokyo?" },
                { type: "said", text: "It's nine in the evening.", via: "direct" }
            ])
        ).toEqual([{ user: "What time is it in Tokyo?", assistant: "It's nine in the evening." }]);
    });
    it("waits for a transcript that lands after the reply", () => {
        expect(
            run([
                { type: "said", text: "Hello!", via: "direct" },
                { type: "heard", text: "Hi Polar" }
            ])
        ).toEqual([{ user: "Hi Polar", assistant: "Hello!" }]);
    });
    it("joins two things heard before one reply", () => {
        expect(
            run([
                { type: "heard", text: "Wait." },
                { type: "heard", text: "How are you?" },
                { type: "said", text: "Fine.", via: "direct" }
            ])
        ).toEqual([{ user: "Wait. How are you?", assistant: "Fine." }]);
    });
    it("saves nothing for a delegated exchange, even when its transcript comes late", () => {
        expect(
            run([
                { type: "said", text: "", via: "call" },
                { type: "heard", text: "Make a task to call Ana" },
                { type: "said", text: "Done, the task is made.", via: "reading" },
                { type: "heard", text: "Thanks" },
                { type: "said", text: "Any time.", via: "direct" }
            ])
        ).toEqual([{ user: "Thanks", assistant: "Any time." }]);
    });
    it("ignores empty lines", () => {
        expect(run([{ type: "heard", text: "  " }, { type: "said", text: "", via: "direct" }])).toEqual([]);
    });
});

describe("liveTurnBodySchema", () => {
    const valid = {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user: { id: "u1", text: " hi " },
        assistant: { id: "a1", text: "hello" }
    };
    it("trims, and defaults the parent and temporary", () => {
        expect(liveTurnBodySchema.parse(valid)).toMatchObject({ parentId: null, temporary: false, user: { text: "hi" } });
    });
    it("refuses extra fields, empty lines and a bad thread", () => {
        expect(liveTurnBodySchema.safeParse({ ...valid, role: "system" }).success).toBe(false);
        expect(liveTurnBodySchema.safeParse({ ...valid, user: { id: "u1", text: " " } }).success).toBe(false);
        expect(liveTurnBodySchema.safeParse({ ...valid, threadId: "x" }).success).toBe(false);
    });
});

describe("mintLiveSecret", () => {
    it("asks for speech to speech with transcription and ask_polar, the key in the header only", async () => {
        const sent: Array<{ url: string; init: RequestInit }> = [];
        const fake = (async (url: string, init: RequestInit) => {
            sent.push({ url, init });
            return new Response(JSON.stringify({ value: "ek_fixture", expires_at: 1_800_000_000 }), { status: 200 });
        }) as unknown as typeof fetch;
        const grant = await mintLiveSecret({ apiKey: "sk-fixture", lang: "es-ES", fetch: fake });
        expect(grant).toEqual({ value: "ek_fixture", expiresAt: 1_800_000_000 });
        expect(JSON.stringify(grant)).not.toContain("sk-fixture");
        expect(sent).toHaveLength(1);
        expect(sent[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
        expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-fixture");
        const body = JSON.parse(String(sent[0]!.init.body));
        expect(String(sent[0]!.init.body)).not.toContain("sk-fixture");
        expect(body.expires_after.seconds).toBeLessThanOrEqual(60);
        expect(body.session.type).toBe("realtime");
        expect(body.session.audio.input.transcription.model).toBe(LIVE_TRANSCRIBE_MODEL);
        expect(body.session.audio.input.turn_detection.interrupt_response).toBe(true);
        expect(body.session.tools.map((tool: { name: string }) => tool.name)).toEqual([ASK_POLAR_TOOL]);
        expect(body.session.instructions).toContain("es-ES");
    });
    it("answers null when the provider refuses", async () => {
        const fake = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
        expect(await mintLiveSecret({ apiKey: "sk-fixture", lang: null, fetch: fake })).toBeNull();
    });
});
