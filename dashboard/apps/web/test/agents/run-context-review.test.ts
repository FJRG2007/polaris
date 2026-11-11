/**
 * What a run is told about reviews: the review settings reach Review mode
 * (incremental reviews inherit Review's text in the runtime) beside whatever an
 * automation forced, recipes reach every mode as standing guidance, and a
 * repository nobody configured is told nothing new.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/model-keys", () => ({ runSecretsFor: vi.fn(async () => ({})) }));

import { buildRunContext } from "@/lib/agents/agent-run-context";

const base = {
    ownerId: "owner-1",
    runToken: "token",
    model: "m",
    effort: "medium",
    push: "restricted",
    shell: "restricted",
    instructions: "",
    mode: null,
    gate: "off" as const,
    runId: "run-1",
    apiUrl: "https://polaris.example",
    intent: "x"
};

describe("review settings in the run context", () => {
    it("adds nothing when there is nothing to add", async () => {
        const context = await buildRunContext({ ...base, reviewGuide: "", recipes: "" });
        expect(context.settings.modeInstructions).toEqual({});
        expect(context.settings.learnings).toBeNull();
    });

    it("puts the review guide on Review mode, after a forced Review automation's words", async () => {
        const context = await buildRunContext({
            ...base,
            mode: "Review",
            instructions: "Focus on the API.",
            reviewGuide: "The operator configured this review:\n- Be brief."
        });
        expect(context.settings.modeInstructions.Review).toBe(
            "Focus on the API.\n\nThe operator configured this review:\n- Be brief."
        );
    });

    it("keeps another forced mode's words where they were", async () => {
        const context = await buildRunContext({
            ...base,
            mode: "Fix",
            instructions: "Only touch tests.",
            reviewGuide: "guide"
        });
        expect(context.settings.modeInstructions).toEqual({ Fix: "Only touch tests.", Review: "guide" });
    });

    it("adds recipes to the standing guidance", async () => {
        const context = await buildRunContext({ ...base, instructions: "Be careful.", recipes: "recipes" });
        expect(context.settings.learnings).toBe("Be careful.\n\nrecipes");
    });
});
