/**
 * What the catalogue refuses to store, and what a screen gets when it has never
 * run.
 *
 * The filter is the part with teeth. The unfiltered provider index is not a list
 * of chat models: Groq alone publishes a speech recogniser and two safety
 * classifiers, and a run started on one of those fails in a way nothing explains.
 */

import { describe, expect, it } from "vitest";
import { isUsableForAgents, parseCatalogPayload } from "@/lib/agents/model-catalog";

const PAYLOAD = {
    groq: {
        models: {
            "openai/gpt-oss-120b": {
                id: "openai/gpt-oss-120b",
                name: "GPT OSS 120B",
                tool_call: true,
                reasoning: true,
                release_date: "2025-08-05",
                limit: { context: 131072, output: 65536 },
                cost: { input: 0.15, output: 0.6 },
                reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }]
            },
            "whisper-large-v3": { id: "whisper-large-v3", name: "Whisper", limit: { context: 0, output: 0 } },
            "meta-llama/llama-prompt-guard-2-22m": {
                id: "meta-llama/llama-prompt-guard-2-22m",
                name: "Prompt Guard",
                limit: { context: 512, output: 512 }
            }
        }
    },
    // A provider Polaris holds no credential for. Offering its models would be
    // offering a run that cannot start.
    mistral: { models: { "mistral-large": { id: "mistral-large", tool_call: true, limit: { context: 128000 } } } }
};

describe("isUsableForAgents", () => {
    it("keeps a tool-calling model with a real window", () => {
        expect(isUsableForAgents({ id: "x", tool_call: true, limit: { context: 131072 } })).toBe(true);
    });

    it("drops a model that cannot call tools", () => {
        // An agent IS a tool-calling loop, so this is not a quality judgement.
        expect(isUsableForAgents({ id: "whisper-large-v3", limit: { context: 8192 } })).toBe(false);
    });

    it("drops a model with no declared window", () => {
        // Zero is "the catalogue did not say", and a picker that showed it as a
        // size would be inventing one.
        expect(isUsableForAgents({ id: "x", tool_call: true, limit: { context: 0 } })).toBe(false);
        expect(isUsableForAgents({ id: "x", tool_call: true })).toBe(false);
    });
});

describe("parseCatalogPayload", () => {
    it("keeps only supported providers and usable models", () => {
        const rows = parseCatalogPayload(PAYLOAD);
        expect(rows.map((row) => row.slug)).toEqual(["groq/openai/gpt-oss-120b"]);
    });

    it("carries the numbers a screen has to show", () => {
        const [row] = parseCatalogPayload(PAYLOAD);
        expect(row).toMatchObject({
            provider: "groq",
            modelId: "openai/gpt-oss-120b",
            name: "GPT OSS 120B",
            contextTokens: 131072,
            outputTokens: 65536,
            costInput: 0.15,
            reasoning: true
        });
    });

    it("carries the effort rungs the model publishes", () => {
        // The runtime logged `effort: not applied - model not recognized` for
        // exactly this model, because nothing here knew it had a ladder.
        const [row] = parseCatalogPayload(PAYLOAD);
        expect(JSON.parse(row.effortRungs)).toEqual(["low", "medium", "high"]);
    });

    it("returns nothing for a payload it does not recognise", () => {
        // An empty result is what stops a bad download replacing a good catalogue.
        expect(parseCatalogPayload({ groq: { models: { x: { name: "no id" } } } })).toEqual([]);
        expect(parseCatalogPayload(null)).toEqual([]);
        expect(parseCatalogPayload("nonsense")).toEqual([]);
    });
});
