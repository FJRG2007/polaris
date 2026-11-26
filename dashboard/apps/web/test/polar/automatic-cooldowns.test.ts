/**
 * Automatic's cooldowns: the providers that answer go first, failing ones
 * after, ones out of credit last; every noted entry is shared through the
 * sink and an entry noted elsewhere is taken in. A model that ended a turn
 * with tools and no answer is kept off such turns like one that wrote its
 * calls as text.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolarModelOption, PolarProviderOption } from "@/lib/polar/models";
import * as automatic from "@/lib/polar/automatic";
import { liveEntries, mergedEntries } from "@/lib/polar/cooldown-store";
import { failureLogLine, passedOverOf } from "@/lib/polar/provider-failure";

function option(provider: string, model: string): PolarModelOption {
    return {
        provider,
        providerName: provider,
        model,
        name: model,
        reasoning: false,
        attachment: false,
        contextTokens: 0,
        providerContextTokens: null,
        costInput: 1,
        costOutput: 1,
        releaseDate: null
    } satisfies PolarModelOption;
}

function providers(...models: PolarModelOption[]): PolarProviderOption[] {
    const slugs = [...new Set(models.map((model) => model.provider))];
    return slugs.map((slug) => ({
        provider: slug,
        name: slug,
        payers: ["own"],
        models: models.filter((model) => model.provider === slug)
    })) as PolarProviderOption[];
}

afterEach(() => automatic.shareCooldownsWith(null));

describe("automaticCandidates tiers", () => {
    it("puts healthy providers first, failing next, unpaid last", () => {
        const list = providers(option("broke", "b-70b"), option("flaky", "f-70b"), option("good", "g-70b"));
        const picked = automatic.automaticCandidates(
            list,
            automatic.PLAIN_TURN,
            new Set(["flaky"]),
            new Set(["broke"])
        );
        expect(picked.map((model) => model.provider)).toEqual(["good", "flaky", "broke"]);
    });
});

describe("shared cooldowns", () => {
    it("sends every noted entry to the sink with when it ends", () => {
        const sink = vi.fn();
        automatic.shareCooldownsWith(sink);
        automatic.noteProviderFailure("sink-user", "groq", 1_000);
        expect(sink).toHaveBeenCalledWith("sink-user", "failing", "groq", 1_000 + automatic.FAILURE_MS);
    });

    it("takes an entry noted elsewhere while it is live", () => {
        const now = 50_000;
        automatic.adoptCooldown("adopt-user", "failing", "mistral", now + 60_000, now);
        automatic.adoptCooldown("adopt-user", "failing", "gone-by", now - 1, now);
        expect(automatic.failingProviders("adopt-user", now)).toEqual(new Set(["mistral"]));
    });

    it("keeps a model with no final answer off turns with tools", () => {
        automatic.noteNoFinalAnswer("quiet-user", "copilot", "some-model", 1_000);
        expect(automatic.garbledModels("quiet-user", 2_000)).toEqual(new Set(["copilot/some-model"]));
        expect(automatic.garbledModels("quiet-user", 1_000 + automatic.GARBLED_MS + 1)).toEqual(new Set());
    });
});

describe("cooldown store rows", () => {
    it("reads only live, well-formed entries", () => {
        const value = JSON.stringify([
            { memo: "failing", subject: "groq", until: 200 },
            { memo: "failing", subject: "old", until: 50 },
            { memo: "nonsense", subject: "x", until: 300 },
            "garbage"
        ]);
        expect(liveEntries(value, 100)).toEqual([{ memo: "failing", subject: "groq", until: 200 }]);
        expect(liveEntries("not json", 100)).toEqual([]);
        expect(liveEntries(null, 100)).toEqual([]);
    });

    it("keeps the later end of one entry noted twice", () => {
        const merged = mergedEntries([{ memo: "unpaid", subject: "xai", until: 500 }], {
            memo: "unpaid",
            subject: "xai",
            until: 300
        });
        expect(merged).toEqual([{ memo: "unpaid", subject: "xai", until: 500 }]);
    });
});

describe("what a stand-in passed over", () => {
    it("reads a valid list and drops anything else", () => {
        expect(passedOverOf([{ provider: "Groq", kind: "credit" }])).toEqual([{ provider: "Groq", kind: "credit" }]);
        expect(passedOverOf("nope")).toEqual([]);
    });
});

describe("failureLogLine", () => {
    it("says what the provider answered when the error is given", () => {
        const line = failureLogLine(
            "a turn",
            "Copilot",
            { kind: "other", status: 400 },
            new Error("model not supported")
        );
        expect(line.startsWith("polar: a turn failed at Copilot (400, other): ")).toBe(true);
        expect(line).toContain("model not supported");
    });
});
