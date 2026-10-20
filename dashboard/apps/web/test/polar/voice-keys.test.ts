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
    instanceKey: false
};

vi.mock("@/lib/polar/access", async () => (await import("./fixtures/open-polar-access")).openPolarAccess());
vi.mock("@/lib/agents/model-keys", () => ({
    keySourcesFor: async () => {
        state.reads += 1;
        return state.sources;
    },
    chatCredentialFor: async (_userId: string, provider: string, payer: string | null) => {
        state.asked.push({ provider, payer });
        if (payer === "instance" && !state.instanceKey) return null;
        return { provider, source: payer ?? "own", secret: "sk-fixture", baseUrl: null };
    }
}));
vi.mock("@ai-sdk/openai", () => ({
    createOpenAI: () => ({
        transcription: (id: string) => ({ id, provider: "openai" }),
        speech: (id: string) => ({ id, provider: "openai" })
    })
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
});

describe("the key Polar's voice spends", () => {
    it("reads the key store once for the sentences of one answer", async () => {
        const id = `user-${user}`;
        for (let sentence = 0; sentence < 5; sentence += 1) {
            expect(await voice.polarSpeaker(id)).toMatchObject({ voice: "alloy", format: "mp3" });
        }
        expect(await voice.polarTranscriber(id)).toMatchObject({ provider: "openai" });
        expect(state.reads).toBe(1);
        expect(state.asked).toHaveLength(1);
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
        expect(await voice.polarTranscriber(id, "instance")).toMatchObject({ provider: "openai" });
        expect(await voice.polarSpeaker(id, "own")).not.toBeNull();
        expect(state.asked.map((entry) => entry.payer)).toEqual(["instance", "instance", "own"]);
    });
});
