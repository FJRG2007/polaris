/**
 * Automatic never answers a conversation with a model that cannot hold one:
 * cheapest-first would otherwise land on an on-device "edge" model that only
 * continues the transcript it is shown.
 */

import { describe, expect, it } from "vitest";
import type { PolarModelOption, PolarProviderOption } from "@/lib/polar/models";
import { automaticCandidates, holdsConversation, PLAIN_TURN } from "@/lib/polar/automatic";

function option(model: string, extra: Partial<PolarModelOption> = {}): PolarModelOption {
    return {
        provider: "openrouter",
        providerName: "OpenRouter",
        model,
        name: model,
        reasoning: false,
        attachment: false,
        contextTokens: 128_000,
        providerContextTokens: null,
        costInput: 1,
        costOutput: 1,
        inputs: ["text"],
        releaseDate: null,
        ...extra
    };
}

function providers(...models: PolarModelOption[]): PolarProviderOption[] {
    return [{ provider: "openrouter", name: "OpenRouter", payers: ["own"], models }];
}

describe("a model that can hold a conversation", () => {
    it("is not an edge, guard, embedding or speech model", () => {
        expect(holdsConversation(option("rekaai/reka-edge", { name: "Reka Edge" }))).toBe(false);
        expect(holdsConversation(option("meta-llama/llama-guard-4-12b"))).toBe(false);
        expect(holdsConversation(option("mistral-ocr-latest"))).toBe(false);
        expect(holdsConversation(option("text-embedding-3-small"))).toBe(false);
        expect(holdsConversation(option("whisper-large-v3"))).toBe(false);
    });

    it("is not tiny by its stated size, its window or its longest answer", () => {
        expect(holdsConversation(option("qwen/qwen3-1.7b"))).toBe(false);
        expect(holdsConversation(option("some-model", { contextTokens: 4_096 }))).toBe(false);
        expect(holdsConversation(option("some-model", { outputTokens: 256 }))).toBe(false);
        expect(holdsConversation(option("some-model", { inputs: ["audio"] }))).toBe(false);
    });

    it("keeps chat models, and those the catalogue says nothing about", () => {
        expect(holdsConversation(option("qwen/qwen3.8-27b"))).toBe(true);
        expect(holdsConversation(option("baidu/ernie-5.5-flash-preview:free"))).toBe(true);
        expect(holdsConversation(option("mistral-medium-latest"))).toBe(true);
        expect(holdsConversation(option("gpt-5-mini"))).toBe(true);
        expect(holdsConversation(option("knowledge-model"))).toBe(true);
        expect(holdsConversation(option("deployment", { contextTokens: 0, inputs: [] }))).toBe(true);
    });
});

describe("Automatic's candidates for a chat answer", () => {
    it("drop an edge model even when it is the cheapest", () => {
        const edge = option("rekaai/reka-edge", { name: "Reka Edge", costInput: 0.01 });
        const chat = option("qwen/qwen3.8-27b", { costInput: 0.2 });
        const picked = automaticCandidates(providers(edge, chat), PLAIN_TURN);
        expect(picked.map((model) => model.model)).toEqual(["qwen/qwen3.8-27b"]);
    });

    it("keep the small one rather than leave the turn with nothing", () => {
        const edge = option("rekaai/reka-edge", { name: "Reka Edge" });
        expect(automaticCandidates(providers(edge), PLAIN_TURN)).toHaveLength(1);
    });
});
