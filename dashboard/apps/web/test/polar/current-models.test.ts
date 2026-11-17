import { describe, expect, it } from "vitest";
import {
    automaticCandidates,
    currentModels,
    PLAIN_TURN,
    toolMarkupIn
} from "@/lib/polar/automatic";
import type { PolarModelOption, PolarProviderOption } from "@/lib/polar/models";

const now = new Date("2026-11-17T12:00:00Z");

function model(id: string, releaseDate: string | null, cost = 0.1): PolarModelOption {
    return {
        provider: "example",
        providerName: "Example",
        model: id,
        name: id,
        reasoning: false,
        attachment: false,
        contextTokens: 128_000,
        providerContextTokens: null,
        costInput: cost,
        costOutput: cost,
        inputs: [],
        releaseDate
    };
}

describe("current models", () => {
    it("drops what the field moved past and keeps what has no date", () => {
        const kept = currentModels(
            [
                model("example-nemo", "2024-07-18"),
                model("example-oss-120b", "2025-08-05"),
                model("example-flash", "2026-10-19"),
                model("example-typed", null)
            ],
            now
        );
        expect(kept.map((one) => one.model)).toEqual(["example-flash", "example-typed"]);
    });

    it("moves with the clock", () => {
        const list = [model("example-flash", "2026-10-19")];
        expect(currentModels(list, new Date("2027-10-18T00:00:00Z"))).toHaveLength(1);
        // A year on, nothing is current: the newest stay instead of none.
        expect(currentModels(list, new Date("2027-11-01T00:00:00Z"))).toHaveLength(1);
        const two = [model("example-old", "2024-01-01"), model("example-new", "2026-10-19")];
        expect(currentModels(two, new Date("2027-11-01T00:00:00Z")).map((one) => one.model)).toEqual([
            "example-old",
            "example-new"
        ]);
    });
});

describe("tool calls written as text", () => {
    it("recognizes the markup models leak", () => {
        expect(toolMarkupIn('ernie:tool_call <invoke name="mcp_stripe__stripe_api_search">')).toBe(true);
        expect(toolMarkupIn("<tool_call>{\"name\":\"x\"}</tool_call>")).toBe(true);
        expect(toolMarkupIn("<|tool_calls_section_begin|>")).toBe(true);
        expect(toolMarkupIn("Your next payout arrives on Friday.")).toBe(false);
        expect(toolMarkupIn("Use the `invoke` method of the client.")).toBe(false);
    });

    it("keeps a model that garbled them off a turn that offers tools", () => {
        const providers: PolarProviderOption[] = [
            {
                provider: "example",
                name: "Example",
                payers: ["own"],
                models: [model("example-garbled", "2026-10-01", 0.01), model("example-good", "2026-10-01", 0.2)]
            }
        ];
        const agentic = { ...PLAIN_TURN, agentic: true };
        const garbled = new Set(["example/example-garbled"]);
        expect(automaticCandidates(providers, agentic)[0]!.model).toBe("example-garbled");
        expect(
            automaticCandidates(providers, agentic, new Set(), new Set(), garbled).map((one) => one.model)
        ).toEqual(["example-good"]);
    });
});
