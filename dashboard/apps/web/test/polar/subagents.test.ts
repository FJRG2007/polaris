import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: { id: string; status?: string; summary?: string }[] = [];

vi.mock("@/lib/polar/subagents/store", () => ({
    createSubagentRun: vi.fn(async (input: { id: string }) => void saved.push({ id: input.id })),
    saveSubagentProgress: vi.fn(async () => undefined),
    endSubagentRun: vi.fn(async (id: string, end: { status: string; summary: string }) => {
        const row = saved.find((entry) => entry.id === id);
        if (row) Object.assign(row, end);
    }),
    resumableRun: vi.fn(async () => null)
}));
vi.mock("@/lib/polar/credit", () => ({ polarOutputTokens: () => 1000 }));

import * as shared from "@/lib/polar/subagents/shared";
import * as registry from "@/lib/polar/subagents/registry";
import { subagentTypes } from "@/lib/polar/subagents/types";
import * as subagentTools from "@/lib/polar/subagents/tools";
import { taskModelText } from "@/lib/polar/subagents/task-tool";
import { runSubagent, type SubagentHost } from "@/lib/polar/subagents/runner";

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
};

const ran: string[] = [];
const parentTools = (): ToolSet => ({
    read_things: tool({
        description: "read",
        inputSchema: z.object({}),
        execute: async () => (ran.push("read_things"), { ok: true, text: "read" })
    }),
    delete_things: tool({
        description: "delete",
        inputSchema: z.object({}),
        execute: async () => (ran.push("delete_things"), { ok: true, text: "deleted" })
    }),
    web_search: tool({
        description: "web",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true })
    }),
    [shared.TASK_TOOL]: tool({
        description: "task",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true })
    })
});

function textModel(text: string) {
    return new MockLanguageModelV4({
        doGenerate: async () => ({
            content: [{ type: "text" as const, text }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: USAGE,
            warnings: []
        })
    });
}

function hostWith(model: MockLanguageModelV4, overrides: Partial<SubagentHost> = {}): SubagentHost {
    const tools = parentTools();
    return {
        userId: "u1",
        threadId: "22222222-2222-4222-8222-222222222222",
        tools,
        approval: { delete_things: "user-approval" },
        webNames: new Set(["web_search"]),
        active: () => Object.keys(tools),
        resolve: async () =>
            ({
                model,
                option: { provider: "p", providerName: "P", model: "m", name: "M" },
                credential: { source: "own" }
            }) as never,
        signal: new AbortController().signal,
        depth: 0,
        types: subagentTypes([]),
        spent: async () => undefined,
        started: { count: 0 },
        ...overrides
    };
}

const task = (input: Partial<shared.TaskInput> = {}): shared.TaskInput => ({
    description: "Look it up",
    prompt: "Find the thing.",
    type: "general",
    background: false,
    ...input
});

beforeEach(() => {
    registry.resetSubagents();
    saved.length = 0;
    ran.length = 0;
});

describe("subagent tool scope", () => {
    const scope = { readOnly: false, without: new Set<string>(), mayDelegate: false };

    it("never gives a child a tool its parent lacks, nor the task tool at the depth limit", () => {
        const names = subagentTools.scopedToolNames(parentTools(), {}, scope);
        expect(names.sort()).toEqual(["delete_things", "read_things", "web_search"]);
    });

    it("leaves every tool that needs an approval out of a read-only child", () => {
        const names = subagentTools.scopedToolNames(
            { ...parentTools(), polar_remember: parentTools().read_things! },
            { delete_things: "user-approval" },
            { ...scope, readOnly: true, without: new Set(["web_search"]) }
        );
        expect(names).toEqual(["read_things"]);
    });

    it("answers a gated call without running it unless a standing grant approves it", async () => {
        const events = { onStart: vi.fn(), onEnd: vi.fn(), messages: () => [] };
        const gated = subagentTools.scopedTools(
            parentTools(),
            { delete_things: "user-approval" },
            scope,
            events
        );
        const run = (set: ToolSet) =>
            (set.delete_things as { execute: (input: unknown, options: unknown) => Promise<unknown> })
                .execute({}, { toolCallId: "c", messages: [] });
        expect(await run(gated)).toEqual({ ok: false, text: subagentTools.NEEDS_PERSON });
        expect(ran).toEqual([]);
        const granted = subagentTools.scopedTools(
            parentTools(),
            { delete_things: async () => "approved" },
            scope,
            events
        );
        expect(await run(granted)).toEqual({ ok: true, text: "deleted" });
        expect(ran).toEqual(["delete_things"]);
        expect(events.onEnd).toHaveBeenLastCalledWith("delete_things", true);
    });
});

describe("subagent registry", () => {
    it("holds each person to the running ceiling", () => {
        for (let index = 0; index < shared.SUBAGENTS_MAX; index += 1)
            expect(registry.admitSubagent(`a${index}`, "u1", "t")).not.toBeNull();
        expect(registry.admitSubagent("over", "u1", "t")).toBeNull();
        expect(registry.admitSubagent("other", "u2", "t")).not.toBeNull();
        registry.releaseSubagent("a0");
        expect(registry.admitSubagent("again", "u1", "t")).not.toBeNull();
    });

    it("stops and steers only for the owner, and a parent's stop reaches the child", () => {
        const parent = new AbortController();
        const child = registry.admitSubagent("c1", "u1", "t", parent.signal)!;
        expect(registry.stopSubagent("u2", "c1")).toBe(false);
        expect(registry.steerSubagent("u2", "c1", "hi")).toBe(false);
        expect(registry.steerSubagent("u1", "c1", "hi")).toBe(true);
        expect(registry.takeSteers("c1")).toEqual(["hi"]);
        expect(registry.takeSteers("c1")).toEqual([]);
        parent.abort();
        expect(child.signal.aborted).toBe(true);
    });
});

describe("runSubagent", () => {
    it("runs a child on its own context and hands back only its report", async () => {
        let prompt: unknown = null;
        const model = new MockLanguageModelV4({
            doGenerate: async (options) => {
                prompt = options.prompt;
                return {
                    content: [{ type: "text" as const, text: "Found it: 42." }],
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: USAGE,
                    warnings: []
                };
            }
        });
        const host = hostWith(model);
        const end = await runSubagent(host, { input: task(), toolCallId: "call-1" });
        expect(typeof end).toBe("object");
        const output = end as shared.TaskOutput;
        expect(output.status).toBe("done");
        expect(output.summary).toBe("Found it: 42.");
        expect(saved[0]).toMatchObject({ status: "done", summary: "Found it: 42." });
        expect(JSON.stringify(prompt)).toContain("Find the thing.");
        expect(host.started.count).toBe(1);
        expect(registry.runningCount("u1")).toBe(0);
        expect(taskModelText(output)).toContain("Found it: 42.");
        expect(taskModelText(output)).not.toContain("steps");
    });

    it("refuses a type that does not exist and a person at the ceiling", async () => {
        const host = hostWith(textModel("x"));
        expect(await runSubagent(host, { input: task({ type: "nope" }), toolCallId: null })).toBe(
            "unknown_type"
        );
        for (let index = 0; index < shared.SUBAGENTS_MAX; index += 1)
            registry.admitSubagent(`busy${index}`, "u1", "t");
        expect(await runSubagent(host, { input: task(), toolCallId: null })).toBe("too_many");
        expect(saved).toEqual([]);
    });

    it("stops a waited-on child when the parent turn is stopped", async () => {
        const parent = new AbortController();
        const model = new MockLanguageModelV4({
            doGenerate: (options) =>
                new Promise((_resolve, reject) => {
                    options.abortSignal?.addEventListener("abort", () =>
                        reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
                    );
                    setTimeout(() => parent.abort(), 5);
                })
        });
        const end = await runSubagent(hostWith(model, { signal: parent.signal }), {
            input: task(),
            toolCallId: null
        });
        expect((end as shared.TaskOutput).status).toBe("stopped");
        expect(registry.runningCount("u1")).toBe(0);
    });

    it("keeps a background child running after the parent turn stops", async () => {
        const parent = new AbortController();
        parent.abort();
        const end = await runSubagent(hostWith(textModel("Done later."), { signal: parent.signal }), {
            input: task({ background: true }),
            toolCallId: null
        });
        expect((end as shared.TaskOutput).status).toBe("done");
    });

    it("gives an explore child no tool that needs an approval", async () => {
        let offered: string[] = [];
        const model = new MockLanguageModelV4({
            doGenerate: async (options) => {
                offered = (options.tools ?? []).map((entry) => entry.name);
                return {
                    content: [{ type: "text" as const, text: "ok" }],
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: USAGE,
                    warnings: []
                };
            }
        });
        await runSubagent(hostWith(model), { input: task({ type: "explore" }), toolCallId: null });
        expect(offered.sort()).toEqual(["read_things", "web_search"]);
    });
});
