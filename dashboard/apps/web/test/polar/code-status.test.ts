/**
 * The Code status line shows what the session reported and leaves out what
 * nobody did, never a made-up number.
 */

import { describe, expect, it } from "vitest";
import { codeStatusParts, contextPercent, shownModel } from "@/lib/polar/code-status";

describe("codeStatusParts", () => {
    it("draws model, effort, context, cost and branch in that order", () => {
        expect(
            codeStatusParts({
                model: "claude-sonnet-4-5-20250929",
                effort: "high",
                context: { used: 50_000, window: 200_000 },
                costUsd: 0.42,
                branch: "polaris/fix-login"
            })
        ).toEqual([
            { kind: "model", value: "claude-sonnet-4-5" },
            { kind: "effort", value: "high" },
            { kind: "context", percent: 25 },
            { kind: "cost", usd: 0.42 },
            { kind: "branch", value: "polaris/fix-login" }
        ]);
    });

    it("leaves out every part that was not reported", () => {
        expect(codeStatusParts({ model: null, effort: null, context: null, costUsd: null, branch: "" })).toEqual(
            []
        );
        // A session with no priced turn has spent nothing worth a number.
        expect(codeStatusParts({ model: null, effort: null, context: null, costUsd: 0, branch: "main" })).toEqual([
            { kind: "branch", value: "main" }
        ]);
    });
});

describe("contextPercent", () => {
    it("rounds down and stays within 0-100", () => {
        expect(contextPercent(1999, 10_000)).toBe(19);
        expect(contextPercent(20_000, 10_000)).toBe(100);
        expect(contextPercent(5, 0)).toBe(0);
    });
});

describe("shownModel", () => {
    it("drops the date stamp only", () => {
        expect(shownModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
        expect(shownModel("gpt-5-codex")).toBe("gpt-5-codex");
    });
});
