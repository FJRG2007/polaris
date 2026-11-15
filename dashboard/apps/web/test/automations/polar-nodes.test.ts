/**
 * Polar's automation steps with the model mocked.
 *
 * Pinned: a decision leaves by the port of the outcome the model named (any
 * casing), asks once more when the answer is not the JSON asked for, and on
 * failure takes its configured fallback - the error port, one outcome, or the
 * run's failure - never a port with nothing wired to it; Write hands back the
 * text; Extract types each field and refuses a required one that is missing.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
    answers: [] as string[],
    asked: [] as { system: string; prompt: string }[],
    fail: null as Error | null
}));
vi.mock("@/lib/automations/nodes/polar-model", () => ({
    polarStepSystem: (instructions: string, task: string) => `${task}\n${instructions}`,
    polarAsker: async () => {
        if (model.fail) throw model.fail;
        return {
            user: { id: "u1" },
            agent: null,
            instructions: "",
            async ask(input: { system: string; prompt: string }) {
                model.asked.push({ system: input.system, prompt: input.prompt });
                return { text: model.answers.shift() ?? "", steps: 1, model: "Test model" };
            }
        };
    }
}));

const { aiDecideNode, aiWriteNode, aiExtractNode } =
    await import("@/lib/automations/nodes/polar-nodes");
const { StepError } = await import("@/lib/automations/types");

function io(wired: string[] = []) {
    return {
        actor: { id: "u1", isAdmin: false },
        runId: "r1",
        automationId: "a1",
        idempotencyKey: "r1:d:0",
        depth: 0,
        since: new Date(),
        leads: (port: string) => wired.includes(port),
        shelf: { orgId: null, userId: "u1" },
        timeZone: "UTC",
        signal: new AbortController().signal,
        allowLocalNetwork: false,
        secret: async () => "never",
        recordInput: () => undefined
    };
}
const context = {
    trigger: { payload: { message: "Please refund my order" } },
    steps: {},
    run: { id: "r1", startedAt: null, status: null, error: null },
    automation: { id: "a1", name: "Triage" },
    now: new Date().toISOString()
};

function decide(extra: Record<string, unknown> = {}) {
    return core.aiDecideConfigSchema.parse({
        input: "{{trigger.payload.message}}",
        cases: [
            { label: "Approve", description: "A fair request" },
            { label: "Discard", description: "Spam" }
        ],
        ...extra
    });
}

beforeEach(() => {
    model.answers = [];
    model.asked = [];
    model.fail = null;
});

describe("AI decision", () => {
    it("has one port per outcome, plus error when failures go there", () => {
        expect(core.nodePorts("core.aiDecide", { config: decide() })).toEqual([
            "case1",
            "case2",
            "error"
        ]);
        expect(core.nodePorts("core.aiDecide", { config: decide({ onFailure: "fail" }) })).toEqual([
            "case1",
            "case2"
        ]);
    });

    it("leaves by the outcome the model picked, in any casing", async () => {
        model.answers = ['Sure: {"outcome": "discard", "reason": "Looks like spam"}'];
        const result = await aiDecideNode.run!(decide(), context, io());
        expect(result).toEqual({
            output: { outcome: "case2", label: "Discard", reason: "Looks like spam", failed: false },
            port: "case2"
        });
        expect(model.asked[0]!.prompt).toBe("Please refund my order");
        expect(model.asked[0]!.system).toContain("- Approve: A fair request");
    });

    it("asks once more when the answer is not the JSON asked for", async () => {
        model.answers = ["approve it", '{"outcome":"Approve"}'];
        const result = await aiDecideNode.run!(decide(), context, io());
        expect(result).toMatchObject({ port: "case1" });
        expect(model.asked).toHaveLength(2);
    });

    it("takes the error port when no outcome came back and something is wired to it", async () => {
        model.answers = ['{"outcome":"maybe"}', '{"outcome":"perhaps"}'];
        const result = await aiDecideNode.run!(decide(), context, io(["error"]));
        expect(result).toMatchObject({ port: "error", output: { failed: true, error: "polarNoOutcome" } });
    });

    it("fails instead of ending quietly when the error port leads nowhere", async () => {
        model.answers = ["no", "no"];
        await expect(aiDecideNode.run!(decide(), context, io())).rejects.toBeInstanceOf(StepError);
    });

    it("takes a chosen outcome, or fails the run, as configured", async () => {
        model.fail = new StepError("polarNoKey");
        await expect(
            aiDecideNode.run!(decide({ onFailure: "case2" }), context, io())
        ).resolves.toMatchObject({ port: "case2", output: { failed: true, label: "Discard" } });
        await expect(
            aiDecideNode.run!(decide({ onFailure: "fail" }), context, io(["error"]))
        ).rejects.toMatchObject({ code: "polarNoKey" });
    });

    it("refuses a decision without two named outcomes", () => {
        expect(core.aiDecideConfigSchema.safeParse({ input: "x", cases: [{ label: "A" }] }).success).toBe(false);
        expect(
            core.aiDecideConfigSchema.safeParse({ input: "x", cases: [{ label: "A" }, { label: "a" }] })
                .success
        ).toBe(false);
    });
});

describe("Write with AI", () => {
    it("hands the interpolated prompt to the model and its text to later steps", async () => {
        model.answers = ["Hi, your refund is on its way."];
        const config = core.aiWriteConfigSchema.parse({
            prompt: "Reply to: {{trigger.payload.message}}"
        });
        const result = await aiWriteNode.run!(config, context, io());
        expect(result).toEqual({
            output: { text: "Hi, your refund is on its way.", model: "Test model" }
        });
        expect(model.asked[0]!.prompt).toBe("Reply to: Please refund my order");
    });

    it("refuses a prompt that comes out empty", async () => {
        const config = core.aiWriteConfigSchema.parse({ prompt: "{{trigger.payload.none}}" });
        await expect(aiWriteNode.run!(config, context, io())).rejects.toMatchObject({
            code: "inputRequired"
        });
    });
});

describe("Extract fields", () => {
    const config = core.aiExtractConfigSchema.parse({
        text: "{{trigger.payload.message}}",
        fields: [
            { name: "amount", kind: "number", required: true },
            { name: "urgent", kind: "boolean" },
            { name: "items", kind: "list" }
        ]
    });

    it("types each field and leaves the unknown ones null", async () => {
        model.answers = ['{"amount": "42.5", "urgent": "true", "items": null, "extra": 1}'];
        const result = await aiExtractNode.run!(config, context, io());
        expect(result).toEqual({
            output: { fields: { amount: 42.5, urgent: true, items: null }, missing: [] }
        });
    });

    it("fails when a required field is missing", async () => {
        model.answers = ['{"amount": null}'];
        await expect(aiExtractNode.run!(config, context, io())).rejects.toMatchObject({
            code: "extractMissing"
        });
    });
});
