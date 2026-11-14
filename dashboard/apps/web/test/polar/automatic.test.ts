/**
 * Polar's Automatic model: which kind of turn a request is, and the order the
 * models this person can use are tried in for it.
 */

import { describe, expect, it } from "vitest";
import type { PolarModelOption, PolarProviderOption } from "@/lib/polar/models";
import {
    autoRoute,
    automaticCandidates,
    FAILURE_MS,
    failingProviders,
    LONG_CONTEXT_CHARS,
    LONG_MESSAGE_CHARS,
    noteProviderFailure,
    PLAIN_TURN,
    statedBillions,
    turnSignals
} from "@/lib/polar/automatic";
import { automaticChoice, isAutomatic, modelChoiceSchema } from "@/lib/polar/shared";

function option(provider: string, model: string, extra: Partial<PolarModelOption> = {}) {
    return {
        provider,
        providerName: provider,
        model,
        name: model,
        reasoning: false,
        attachment: false,
        contextTokens: 0,
        providerContextTokens: null,
        costInput: null,
        releaseDate: null,
        ...extra
    } satisfies PolarModelOption;
}

function providers(...models: PolarModelOption[]): PolarProviderOption[] {
    const slugs = [...new Set(models.map((model) => model.provider))];
    return slugs.map((slug) => ({
        provider: slug,
        name: slug,
        payers: ["own"],
        models: models.filter((model) => model.provider === slug)
    }));
}

const MINI = option("openai", "mini", { costInput: 0.15, contextTokens: 128_000 });
const FLASH = option("google-ai", "flash", { costInput: 0.1, attachment: true });
const THINKER = option("anthropic", "thinker", {
    reasoning: true,
    attachment: true,
    costInput: 3,
    releaseDate: "2026-05-01",
    contextTokens: 200_000
});
const OLD_THINKER = option("openai", "o-old", {
    reasoning: true,
    costInput: 10,
    releaseDate: "2025-01-01",
    contextTokens: 100_000
});
const ALL = providers(MINI, FLASH, THINKER, OLD_THINKER);

const names = (list: PolarModelOption[]) => list.map((model) => model.model);

describe("turnSignals", () => {
    it("reads files on the newest message, tool parts anywhere and text lengths", () => {
        const signals = turnSignals([
            { role: "user", parts: [{ type: "text", text: "hello" }] },
            {
                role: "assistant",
                parts: [{ type: "tool-read_tasks" }, { type: "text", text: "done" }]
            },
            {
                role: "user",
                parts: [{ type: "text", text: "and this" }, { type: "file" }]
            }
        ]);
        expect(signals).toEqual({ files: 1, tools: true, contextChars: 17, lastChars: 8 });
    });

    it("is plain for no messages", () => {
        expect(turnSignals([])).toEqual(PLAIN_TURN);
    });
});

describe("autoRoute", () => {
    it("sends a short plain question to a fast model", () => {
        expect(autoRoute({ ...PLAIN_TURN, lastChars: 40, contextChars: 40 })).toBe("fast");
    });

    it.each([
        ["a file", { files: 1 }],
        ["tool work", { tools: true }],
        ["a long message", { lastChars: LONG_MESSAGE_CHARS + 1 }],
        ["a long conversation", { contextChars: LONG_CONTEXT_CHARS + 1 }]
    ])("sends %s to a reasoning model", (_label, extra) => {
        expect(autoRoute({ ...PLAIN_TURN, ...extra })).toBe("reasoning");
    });
});

describe("automaticCandidates", () => {
    it("tries models that do not reason first for a fast turn, cheapest first", () => {
        expect(names(automaticCandidates(ALL, PLAIN_TURN))).toEqual([
            "flash",
            "mini",
            "thinker",
            "o-old"
        ]);
    });

    it("tries reasoning models first for a heavy turn, newest first", () => {
        expect(names(automaticCandidates(ALL, { ...PLAIN_TURN, tools: true }))).toEqual([
            "thinker",
            "o-old",
            "mini",
            "flash"
        ]);
    });

    it("only offers models that read files when the turn carries one", () => {
        expect(names(automaticCandidates(ALL, { ...PLAIN_TURN, files: 2 }))).toEqual([
            "thinker",
            "flash"
        ]);
    });

    it("keeps every model when none reads files, rather than none", () => {
        expect(
            names(automaticCandidates(providers(MINI, OLD_THINKER), { ...PLAIN_TURN, files: 1 }))
        ).toEqual(["o-old", "mini"]);
    });

    it("leaves out a model whose window cannot hold the conversation", () => {
        const chars = 150_000 * 4;
        expect(
            names(automaticCandidates(ALL, { ...PLAIN_TURN, contextChars: chars, lastChars: 10 }))
        ).toEqual(["thinker", "flash"]);
    });

    it("tries a provider that failed a moment ago last", () => {
        expect(names(automaticCandidates(ALL, PLAIN_TURN, new Set(["google-ai"])))).toEqual([
            "mini",
            "thinker",
            "o-old",
            "flash"
        ]);
    });

    it("has nothing to offer a person with no models", () => {
        expect(automaticCandidates([], PLAIN_TURN)).toEqual([]);
    });
});

describe("failure memo", () => {
    it("remembers a failed provider per person for a few minutes", () => {
        const now = 1_000_000;
        noteProviderFailure("user-a", "openai", now);
        expect(failingProviders("user-a", now + 1000)).toEqual(new Set(["openai"]));
        expect(failingProviders("user-b", now + 1000)).toEqual(new Set());
        expect(failingProviders("user-a", now + FAILURE_MS + 1)).toEqual(new Set());
    });
});

describe("a turn that offers tools", () => {
    // What the operator met: a short device command went the fast way, the
    // first free model was unavailable, and an 8B model answered "I can't help".
    const DEVSTRAL = option("nvidia", "mistralai/devstral-small-2", {
        name: "Devstral Small 2",
        costInput: 0,
        releaseDate: "2025-12-01"
    });
    const LLAMA_8B = option("nvidia", "meta/llama-3.1-8b-instruct", {
        name: "Llama-3.1-8B-Instruct",
        costInput: 0,
        releaseDate: "2024-07-23"
    });
    const GEMMA_4B = option("nvidia", "google/gemma-3-4b-it", { costInput: 0 });
    const OSS_20B = option("nvidia", "openai/gpt-oss-20b", { costInput: 0, releaseDate: "2025-08-05" });
    const TOOLED = { ...PLAIN_TURN, lastChars: 30, contextChars: 30, agentic: true };

    it("reads the parameter count a model states, and none when it states none", () => {
        expect(statedBillions(LLAMA_8B)).toBe(8);
        expect(statedBillions(GEMMA_4B)).toBe(4);
        expect(statedBillions(OSS_20B)).toBe(20);
        expect(statedBillions(option("x", "qwen/qwen3-235b-a22b"))).toBe(235);
        expect(statedBillions(option("x", "qwen2.5-1.5b-instruct"))).toBe(1.5);
        expect(statedBillions(option("x", "mistralai/mixtral-8x7b-instruct"))).toBe(56);
        expect(statedBillions(DEVSTRAL)).toBeNull();
        expect(statedBillions(MINI)).toBeNull();
    });

    it("never leaves a model too small to call tools in the line while a larger one fits", () => {
        const list = names(
            automaticCandidates(providers(LLAMA_8B, GEMMA_4B, DEVSTRAL, OSS_20B), TOOLED)
        );
        expect(list).toEqual(["mistralai/devstral-small-2", "openai/gpt-oss-20b"]);
    });

    it("so the stand-in after an unavailable first pick is not the 8B model", () => {
        const list = automaticCandidates(
            providers(DEVSTRAL, LLAMA_8B, OSS_20B),
            TOOLED,
            new Set(),
            new Set()
        );
        expect(list[1]?.model).toBe("openai/gpt-oss-20b");
        expect(list.some((model) => model.model === LLAMA_8B.model)).toBe(false);
    });

    it("keeps the small models when they are all there is", () => {
        expect(names(automaticCandidates(providers(LLAMA_8B, GEMMA_4B), TOOLED))).toEqual([
            "meta/llama-3.1-8b-instruct",
            "google/gemma-3-4b-it"
        ]);
    });

    it("leaves a turn with no tools, such as a summary, free to use the smallest", () => {
        expect(
            names(automaticCandidates(providers(LLAMA_8B, DEVSTRAL), { ...TOOLED, agentic: false }))
        ).toContain("meta/llama-3.1-8b-instruct");
        expect(
            names(automaticCandidates(providers(LLAMA_8B, GEMMA_4B, DEVSTRAL), PLAIN_TURN))
        ).toContain("meta/llama-3.1-8b-instruct");
    });

    it("breaks a tie in price on the fast route with the newer model", () => {
        expect(
            names(automaticCandidates(providers(LLAMA_8B, DEVSTRAL), PLAIN_TURN))[0]
        ).toBe("mistralai/devstral-small-2");
    });
});

describe("the Automatic choice", () => {
    it("is a model choice the route accepts and recognises", () => {
        const choice = modelChoiceSchema.parse(automaticChoice("deep"));
        expect(isAutomatic(choice)).toBe(true);
        expect(choice.intelligence).toBe("deep");
        expect(isAutomatic({ provider: "openai", model: "auto" })).toBe(false);
        expect(isAutomatic(null)).toBe(false);
    });
});
