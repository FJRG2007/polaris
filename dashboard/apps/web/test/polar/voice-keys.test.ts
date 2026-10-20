/**
 * Which key Polar's ears and voice spend: only the payer picked for the chat
 * when there is one, and read once for the sentences of one answer rather
 * than once a sentence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    sources: new Map<string, string>([["openai", "own"]]),
    reads: 0,
    asked: [] as Array<{ provider: string; payer: string | null }>,
    instanceKey: false,
    stored: null as string | null,
    /** Providers whose key only the person holds, for a payer test. */
    ownOnly: new Set<string>()
};

vi.mock("@polaris/db", () => ({
    prisma: {
        polarPreference: {
            findUnique: async () => (state.stored ? { transcriptionModel: state.stored } : null)
        }
    }
}));

vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/agents/model-keys", () => ({
    keySourcesFor: async () => {
        state.reads += 1;
        return state.sources;
    },
    chatCredentialFor: async (_userId: string, provider: string, payer: string | null) => {
        state.asked.push({ provider, payer });
        if (payer === "instance" && (!state.instanceKey || state.ownOnly.has(provider))) return null;
        return { provider, source: payer ?? "own", secret: "sk-fixture", baseUrl: null };
    }
}));
vi.mock("@ai-sdk/openai", () => ({
    createOpenAI: () => ({
        transcription: (id: string) => ({ id, provider: "openai" }),
        speech: (id: string) => ({ id, provider: "openai" })
    })
}));
vi.mock("@ai-sdk/groq", () => ({
    createGroq: () => ({ transcription: (id: string) => ({ id, provider: "groq" }) })
}));
vi.mock("@ai-sdk/elevenlabs", () => ({
    createElevenLabs: () => ({ transcription: (id: string) => ({ id, provider: "elevenlabs" }) })
}));
vi.mock("@ai-sdk/google", () => ({
    createGoogle: () => ({
        transcription: (id: string) => ({ id, provider: "google" }),
        speech: (id: string) => ({ id, provider: "google" })
    })
}));

const voice = await import("@/lib/polar/voice");

let user = 0;
beforeEach(() => {
    user += 1;
    state.sources = new Map([["openai", "own"]]);
    state.reads = 0;
    state.asked = [];
    state.instanceKey = false;
    state.stored = null;
    state.ownOnly = new Set();
});

describe("the key Polar's voice spends", () => {
    it("reads the key store once for the sentences of one answer", async () => {
        const id = `user-${user}`;
        for (let sentence = 0; sentence < 5; sentence += 1) {
            expect(await voice.polarSpeaker(id)).toMatchObject({ voice: "alloy", format: "mp3" });
        }
        expect(state.reads).toBe(1);
        expect(state.asked).toHaveLength(1);
        expect(await voice.polarTranscriber(id)).toMatchObject({ model: { provider: "openai" } });
    });

    it("asks again after a while, and right away when nothing was found", async () => {
        const id = `user-${user}`;
        state.sources = new Map();
        expect(await voice.polarSpeaker(id)).toBeNull();
        state.sources = new Map([["openai", "own"]]);
        expect(await voice.polarSpeaker(id)).not.toBeNull();
        expect(state.reads).toBe(2);
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 31_000);
        expect(await voice.polarSpeaker(id)).not.toBeNull();
        vi.useRealTimers();
        expect(state.reads).toBe(3);
    });

    it("spends only the key of whoever was picked to pay", async () => {
        const id = `user-${user}`;
        expect(await voice.polarSpeaker(id, "instance")).toBeNull();
        expect(state.asked).toEqual([{ provider: "openai", payer: "instance" }]);
        state.instanceKey = true;
        expect(await voice.polarTranscriber(id, "instance")).toMatchObject({
            model: { provider: "openai" },
            source: "instance"
        });
        expect(await voice.polarSpeaker(id, "own")).not.toBeNull();
        expect(state.asked.map((entry) => entry.payer)).toEqual(["instance", "instance", "own"]);
    });
});

describe("the model Polar hears with", () => {
    it("lists every model a key is held for, fastest provider first", async () => {
        state.sources = new Map([
            ["openai", "own"],
            ["groq", "instance"],
            ["anthropic", "own"]
        ]);
        const availability = await voice.polarVoiceAvailability(`user-${user}`);
        expect(availability.dictation).toBe(true);
        expect(availability.transcribers.map((option) => option.id)).toEqual([
            "groq/whisper-large-v3-turbo",
            "groq/whisper-large-v3",
            "openai/gpt-4o-mini-transcribe",
            "openai/gpt-4o-transcribe",
            "openai/whisper-1"
        ]);
        expect(availability.transcriber).toBe("groq/whisper-large-v3-turbo");
    });

    it("can hear with a key that cannot speak, and says it cannot speak", async () => {
        state.sources = new Map([["elevenlabs", "own"]]);
        const availability = await voice.polarVoiceAvailability(`user-${user}`);
        expect(availability).toMatchObject({
            dictation: true,
            speech: false,
            transcriber: "elevenlabs/scribe_v2"
        });
        const heard = await voice.polarTranscriber(`user-${user}`);
        expect(heard?.model).toMatchObject({ id: "scribe_v2", provider: "elevenlabs" });
    });

    it("uses the stored pick, and the sent one over it", async () => {
        state.sources = new Map([
            ["openai", "own"],
            ["groq", "own"]
        ]);
        state.stored = "openai/whisper-1";
        expect((await voice.polarVoiceAvailability(`user-${user}`)).transcriber).toBe(
            "openai/whisper-1"
        );
        expect((await voice.polarTranscriber(`user-${user}`))?.option.id).toBe("openai/whisper-1");
        expect(
            (await voice.polarTranscriber(`user-${user}`, null, "groq/whisper-large-v3"))?.option.id
        ).toBe("groq/whisper-large-v3");
    });

    it("falls back to the fastest held when the picked key is gone", async () => {
        state.sources = new Map([["openai", "own"]]);
        state.stored = "groq/whisper-large-v3-turbo";
        expect((await voice.polarVoiceAvailability(`user-${user}`)).transcriber).toBe(
            "openai/gpt-4o-mini-transcribe"
        );
        expect((await voice.polarTranscriber(`user-${user}`))?.option.id).toBe(
            "openai/gpt-4o-mini-transcribe"
        );
        state.stored = "nonsense with spaces";
        expect((await voice.polarVoiceAvailability(`user-${user}`)).transcriber).toBe(
            "openai/gpt-4o-mini-transcribe"
        );
    });

    it("moves to the next provider when the payer holds no key for the pick", async () => {
        state.sources = new Map([
            ["groq", "own"],
            ["openai", "instance"]
        ]);
        state.instanceKey = true;
        state.ownOnly = new Set(["groq"]);
        const heard = await voice.polarTranscriber(`user-${user}`, "instance");
        expect(heard?.option.id).toBe("openai/gpt-4o-mini-transcribe");
        expect(state.asked.map((entry) => entry.provider)).toEqual(["groq", "openai"]);
    });

    it("has nothing to hear with and says so without a key", async () => {
        state.sources = new Map([["anthropic", "own"]]);
        expect(await voice.polarVoiceAvailability(`user-${user}`)).toEqual({
            dictation: false,
            speech: false,
            transcribers: [],
            transcriber: null
        });
        expect(await voice.polarTranscriber(`user-${user}`)).toBeNull();
    });
});
