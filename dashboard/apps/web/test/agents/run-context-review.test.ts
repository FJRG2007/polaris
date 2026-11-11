/**
 * What a run is told beyond its model and permissions: the review settings
 * reach Review mode (incremental reviews inherit Review's text in the runtime)
 * beside whatever an automation forced, standing guidance reaches every mode,
 * learnings carry only the agent's own notes because the runtime writes them
 * back, linked repositories arrive as read access, and a repository nobody
 * configured is told nothing new.
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

describe("the run context", () => {
    it("adds nothing when there is nothing to add", async () => {
        const context = await buildRunContext({ ...base, reviewGuide: "", recipes: "" });
        expect(context.settings.modeInstructions).toEqual({});
        expect(context.settings.learnings).toBeNull();
        expect(context.settings.xrepo).toBeNull();
    });

    it("puts the review guide on Review mode, after a forced Review automation's words", async () => {
        const context = await buildRunContext({
            ...base,
            mode: "Review",
            instructions: "Focus on the API.",
            reviewGuide: "The operator configured this review:\n- Be brief."
        });
        expect(context.settings.modeInstructions).toEqual({
            Review: "Focus on the API.\n\nThe operator configured this review:\n- Be brief."
        });
    });

    it("files a forced child mode's words under the parent the runtime reads", async () => {
        const context = await buildRunContext({
            ...base,
            mode: "Fix",
            instructions: "Only touch tests.",
            reviewGuide: "guide"
        });
        expect(context.settings.modeInstructions).toEqual({ Build: "Only touch tests.", Review: "guide" });
    });

    it("gives every mode an unforced automation's words and the standing guidance", async () => {
        const context = await buildRunContext({ ...base, instructions: "Be careful.", recipes: "recipes" });
        expect(Object.keys(context.settings.modeInstructions).sort()).toEqual([
            "AddressReviews",
            "Build",
            "Plan",
            "ResolveConflicts",
            "Review",
            "Task"
        ]);
        expect(context.settings.modeInstructions.Plan).toBe("Be careful.\n\nrecipes");
    });

    it("sends only the agent's own notes as learnings", async () => {
        const context = await buildRunContext({
            ...base,
            instructions: "Be careful.",
            recipes: "r",
            learnings: " - npm test\n"
        });
        expect(context.settings.learnings).toBe("- npm test");
    });

    it("passes the linked repositories through as read access", async () => {
        const xrepo = { mode: "explicit" as const, read: ["app", "shared"], write: ["app"], unavailable: [] };
        const context = await buildRunContext({ ...base, xrepo });
        expect(context.settings.xrepo).toEqual(xrepo);
    });
});
