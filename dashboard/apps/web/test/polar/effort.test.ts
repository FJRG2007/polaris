/**
 * The effort pill's decisions: which steps a model offers, what each step
 * becomes on its provider's wire, and the level remembered per model.
 */

import { describe, expect, it } from "vitest";
import * as effort from "@/lib/polar/effort";

const model = (provider: string, id: string, reasoning = true) => ({ provider, model: id, reasoning });

describe("effortControl: the levels shown per model", () => {
    it("hides the pill for a model that does not reason", () => {
        expect(effort.effortControl(model("openai", "gpt-4o", false))).toEqual({ kind: "none" });
        expect(effort.effortControl(null)).toEqual({ kind: "none" });
    });

    it("shows all four steps where Anthropic publishes xhigh", () => {
        expect(effort.effortControl(model("anthropic", "claude-opus-5-5"))).toEqual({
            kind: "ladder",
            levels: ["fast", "balanced", "deep", "max"]
        });
    });

    it("keeps the SDK's translation, every step, for older Anthropic thinking models", () => {
        expect(effort.anthropicRungs("claude-opus-4-5-20251101")).toBeNull();
        expect(effort.anthropicRungs("claude-sonnet-4-5")).toBeNull();
        expect(effort.effortControl(model("anthropic", "claude-sonnet-4-5")).kind).toBe("ladder");
    });

    it("shows three steps on OpenAI, whose xhigh varies by model", () => {
        expect(effort.effortControl(model("openai", "gpt-5.5"))).toEqual({
            kind: "ladder",
            levels: ["fast", "balanced", "deep"]
        });
    });

    it("shows only low and high on Gemini 3 Pro Preview", () => {
        expect(effort.effortControl(model("google-ai", "gemini-3-pro-preview"))).toEqual({
            kind: "ladder",
            levels: ["fast", "deep"]
        });
        expect(effort.googleRungs("gemini-2.5-flash")).toEqual({ fast: "low", balanced: "medium", deep: "high" });
        expect(effort.googleRungs("gemma-3")).toBeNull();
    });

    it("turns DeepSeek into a Think toggle", () => {
        expect(effort.effortControl(model("deepseek", "deepseek-v4-pro"))).toEqual({ kind: "toggle" });
    });

    it("offers every step on a provider without its own mapping", () => {
        expect(effort.effortControl(model("openrouter", "x/y"))).toEqual({
            kind: "ladder",
            levels: ["fast", "balanced", "deep", "max"]
        });
    });
});

describe("clampIntelligence", () => {
    it("lands an unoffered step on the one below, else the lowest", () => {
        const ladder = { kind: "ladder", levels: ["fast", "deep"] } as const;
        expect(effort.clampIntelligence("balanced", ladder)).toBe("fast");
        expect(effort.clampIntelligence("max", ladder)).toBe("deep");
        expect(effort.clampIntelligence("deep", ladder)).toBe("deep");
        expect(effort.clampIntelligence("fast", { kind: "ladder", levels: ["deep"] })).toBe("deep");
    });

    it("reads a toggle as off for fast and on for anything else", () => {
        expect(effort.clampIntelligence("fast", { kind: "toggle" })).toBe("fast");
        expect(effort.clampIntelligence("balanced", { kind: "toggle" })).toBe("deep");
    });
});

describe("effortCallOptions: the provider mapping per model", () => {
    it("sends Anthropic effort with adaptive thinking", () => {
        expect(effort.effortCallOptions(model("anthropic", "claude-opus-5-5"), "xhigh")).toEqual({
            reasoning: "xhigh",
            providerOptions: { anthropic: { effort: "xhigh", thinking: { type: "adaptive", display: "summarized" } } }
        });
    });

    it("sends max where an Anthropic model has max but no xhigh", () => {
        expect(effort.effortCallOptions(model("anthropic", "claude-opus-4-6"), "xhigh").providerOptions).toEqual({
            anthropic: { effort: "max", thinking: { type: "adaptive", display: "summarized" } }
        });
    });

    it("clamps OpenAI to high and names reasoningEffort", () => {
        expect(effort.effortCallOptions(model("openai", "o3"), "xhigh")).toEqual({
            reasoning: "high",
            providerOptions: { openai: { reasoningEffort: "high" } }
        });
    });

    it("sends Gemini a thinking level it has", () => {
        expect(effort.effortCallOptions(model("google-ai", "gemini-3-pro-preview"), "medium").providerOptions).toEqual({
            google: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } }
        });
    });

    it("turns DeepSeek thinking off at fast and on otherwise", () => {
        expect(effort.effortCallOptions(model("deepseek", "deepseek-flash"), "low")).toEqual({
            reasoning: undefined,
            providerOptions: { deepseek: { thinking: { type: "disabled" } } }
        });
        expect(effort.effortCallOptions(model("deepseek", "deepseek-flash"), "medium")).toEqual({
            reasoning: "high",
            providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" } }
        });
    });

    it("sends nothing extra for no level, a model that does not reason, or an unmapped provider", () => {
        expect(effort.effortCallOptions(model("openai", "o3"), undefined)).toEqual({ reasoning: undefined });
        expect(effort.effortCallOptions(model("openai", "gpt-4o", false), "high")).toEqual({ reasoning: "high" });
        expect(effort.effortCallOptions(model("groq", "qwen"), "high")).toEqual({ reasoning: "high" });
    });

    it("merges one provider deep, keeping cache control", () => {
        expect(
            effort.mergeProviderOptions({ anthropic: { cacheControl: { type: "ephemeral" } } }, { anthropic: { effort: "low" } })
        ).toEqual({ anthropic: { cacheControl: { type: "ephemeral" }, effort: "low" } });
        const base = { openai: { user: "x" } };
        expect(effort.mergeProviderOptions(base, undefined)).toBe(base);
    });
});

describe("effort memory: the persistence per person and model", () => {
    it("remembers and recalls a level per model", () => {
        const memory = effort.rememberEffort({}, { provider: "anthropic", model: "claude-opus-5-5", intelligence: "deep" });
        expect(effort.recallEffort(memory, { provider: "anthropic", model: "claude-opus-5-5" })).toBe("deep");
        expect(effort.recallEffort(memory, { provider: "openai", model: "o3" })).toBeNull();
    });

    it("survives a round trip through storage and drops what is not a level", () => {
        const memory = effort.rememberEffort({}, { provider: "openai", model: "o3", intelligence: "fast" });
        expect(effort.readEffortMemory(JSON.stringify(memory))).toEqual(memory);
        expect(effort.readEffortMemory('{"a/b":"loud","c/d":"max"}')).toEqual({ "c/d": "max" });
        expect(effort.readEffortMemory("not json")).toEqual({});
        expect(effort.readEffortMemory("[1]")).toEqual({});
        expect(effort.readEffortMemory(null)).toEqual({});
    });

    it("keeps the newest fifty models", () => {
        let memory: effort.EffortMemory = {};
        for (let index = 0; index < 60; index++) {
            memory = effort.rememberEffort(memory, { provider: "p", model: `m${index}`, intelligence: "deep" });
        }
        expect(Object.keys(memory)).toHaveLength(50);
        expect(effort.recallEffort(memory, { provider: "p", model: "m0" })).toBeNull();
        expect(effort.recallEffort(memory, { provider: "p", model: "m59" })).toBe("deep");
    });
});
