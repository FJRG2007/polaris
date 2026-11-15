// @vitest-environment node
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { MockLanguageModelV4 } from "ai/test";
import { readAsk } from "@/lib/agents/session-asks";
import { NativeSession } from "@/lib/polar/native/engine";
import { nodeWorkspace } from "@/lib/polar/native/workspace";
import { normalizeHookEvent } from "@/lib/agents/session-hooks";
import { decodeClaudeLine } from "@/lib/agents/transcript-decoders";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookPayload, HookSink } from "@/lib/polar/native/hooks";
import { readPermissionRequest } from "@/lib/agents/session-permissions";

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
};

type Step = { text?: string; calls?: { name: string; input: unknown }[] };

/** A model that answers a fixed script, one step per call, and records what
 *  it was sent. */
function scripted(steps: Step[]) {
    let at = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
            prompts.push(options.prompt);
            const step = steps[at++] ?? { text: "Done." };
            const calls = step.calls ?? [];
            return {
                content: [
                    ...(step.text ? [{ type: "text" as const, text: step.text }] : []),
                    ...calls.map((call, index) => ({
                        type: "tool-call" as const,
                        toolCallId: `call-${at}-${index}`,
                        toolName: call.name,
                        input: JSON.stringify(call.input)
                    }))
                ],
                finishReason: calls.length
                    ? { unified: "tool-calls" as const, raw: "tool_use" }
                    : { unified: "stop" as const, raw: "stop" },
                usage: USAGE,
                warnings: []
            };
        }
    });
    return { model, prompts };
}

function recorder(decide: (payload: HookPayload) => Record<string, unknown> = () => ({})) {
    const events: HookPayload[] = [];
    const decisions: HookPayload[] = [];
    const sink: HookSink = {
        event: async (payload) => void events.push(payload),
        decide: async (payload) => {
            decisions.push(payload);
            return decide(payload);
        }
    };
    return { sink, events, decisions };
}

const allow = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
const deny = {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "No." } }
};

let root: string;
let lines: string[];

beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "polar-engine-")));
    lines = [];
});
afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function session(model: MockLanguageModelV4, sink: HookSink, mode?: "default" | "plan" | "acceptEdits") {
    return new NativeSession({
        sessionId: "s-1",
        ws: nodeWorkspace(root),
        model,
        modelName: "test/model",
        hooks: sink,
        writeTranscript: (line) => lines.push(line),
        transcriptPath: path.join(root, ".transcript.jsonl"),
        environment: {
            platform: "linux",
            shell: "sh",
            branch: "polar/x",
            repository: "o/r",
            place: "container",
            date: "2026-11-15",
            memory: [{ file: "AGENTS.md", text: "Use tabs." }]
        },
        ...(mode ? { mode } : {})
    });
}

describe("native session, end to end with a scripted model", () => {
    it("reads, asks permission to edit, edits, and finishes; history decodes as Claude's", async () => {
        await fs.writeFile(path.join(root, "app.ts"), "export const answer = 41;\n");
        const file = path.join(root, "app.ts");
        const { model, prompts } = scripted([
            { text: "Looking.", calls: [{ name: "Read", input: { file_path: file } }] },
            { calls: [{ name: "Edit", input: { file_path: file, old_string: "41", new_string: "42" } }] },
            { text: "Changed the answer to 42." }
        ]);
        const hooks = recorder(() => allow);
        const native = session(model, hooks.sink);
        await native.start();
        const result = await native.turn("Fix the answer", new AbortController().signal);

        expect(result).toMatchObject({ text: "Changed the answer to 42.", interrupted: false, steps: 3 });
        expect(await fs.readFile(file, "utf8")).toBe("export const answer = 42;\n");
        // Only the edit asked; the read needs nobody's yes.
        expect(hooks.decisions.map((payload) => payload.tool_name)).toEqual(["Edit"]);
        expect(readPermissionRequest(hooks.decisions[0])).toMatchObject({ tool: "Edit" });
        // Every event reads as the Claude Code hook Polaris already handles.
        const kinds = hooks.events.map((payload) => normalizeHookEvent(payload)?.kind ?? null);
        expect(kinds).not.toContain(null);
        expect(hooks.events.map((payload) => payload.hook_event_name)).toEqual([
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PreToolUse",
            "PostToolUse",
            "Stop"
        ]);
        // The system prompt carries the environment and the repository's own rules.
        const system = JSON.stringify((prompts[0] as { role: string; content: unknown }[])[0]);
        expect(system).toContain("Use tabs.");
        expect(system).toContain("polar/x");
        // History rows, through the decoder Claude Code sessions use.
        const rows = lines.flatMap(decodeClaudeLine);
        expect(rows.map((row) => `${row.role}:${row.kind}:${row.subject}`)).toEqual([
            "user:text:",
            "agent:text:",
            "agent:tool:Read",
            "agent:result:",
            "agent:tool:Edit",
            "agent:result:",
            "agent:text:"
        ]);
    });

    it("tells the model a denied call did not run, and keeps an always-allow for the session", async () => {
        const { model } = scripted([
            { calls: [{ name: "Bash", input: { command: "echo hi" } }] },
            { calls: [{ name: "Bash", input: { command: "echo again" } }] },
            { text: "ok" }
        ]);
        let answers = 0;
        const hooks = recorder(() => (answers++ === 0 ? deny : allow));
        const native = session(model, hooks.sink);
        await native.turn("run", new AbortController().signal);
        const tool = native.history().filter((message) => message.role === "tool");
        expect(JSON.stringify(tool[0])).toContain("No.");
        expect(JSON.stringify(tool[1])).toContain("again");

        const always = {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }] }
            }
        };
        const second = scripted([
            { calls: [{ name: "Bash", input: { command: "echo 1" } }] },
            { calls: [{ name: "Bash", input: { command: "echo 2" } }] },
            { text: "ok" }
        ]);
        const asked = recorder(() => always);
        await session(second.model, asked.sink).turn("run twice", new AbortController().signal);
        expect(asked.decisions).toHaveLength(1);
    });

    it("withholds writes in plan mode until the plan is approved through the ask route", async () => {
        const file = path.join(root, "new.txt");
        const { model } = scripted([
            { calls: [{ name: "Write", input: { file_path: file, content: "x" } }] },
            { calls: [{ name: "ExitPlanMode", input: { plan: "1. Write new.txt" } }] },
            { calls: [{ name: "Write", input: { file_path: file, content: "x" } }] },
            { text: "Written." }
        ]);
        const hooks = recorder((payload) =>
            payload.hook_event_name === "PreToolUse"
                ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }
                : allow
        );
        const native = session(model, hooks.sink, "plan");
        await native.turn("plan it", new AbortController().signal);
        const plan = hooks.decisions.find((payload) => payload.tool_name === "ExitPlanMode")!;
        expect(readAsk(plan)?.ask.kind).toBe("plan");
        expect(native.state.mode).toBe("default");
        expect(await fs.readFile(file, "utf8")).toBe("x");
        expect(JSON.stringify(native.history())).toContain("Plan mode: nothing may be changed yet");
    });

    it("hands the person's answers to AskUserQuestion back to the model", async () => {
        const questions = [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }];
        const { model } = scripted([{ calls: [{ name: "AskUserQuestion", input: { questions } }] }, { text: "Postgres it is." }]);
        const hooks = recorder(() => ({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { questions, answers: { "Which DB?": "Postgres" } }
            }
        }));
        const native = session(model, hooks.sink);
        await native.turn("set up storage", new AbortController().signal);
        expect(readAsk(hooks.decisions[0])?.ask.kind).toBe("question");
        expect(JSON.stringify(native.history())).toContain('\\"Which DB?\\" = \\"Postgres\\"');
    });

    it("runs a subagent with its own context and returns only its report", async () => {
        await fs.writeFile(path.join(root, "notes.md"), "secret sauce");
        const { model, prompts } = scripted([
            { calls: [{ name: "Task", input: { description: "Find notes", prompt: "Read notes.md", subagent_type: "Explore" } }] },
            { calls: [{ name: "Read", input: { file_path: path.join(root, "notes.md") } }] },
            { text: "notes.md says: secret sauce" },
            { text: "Found it." }
        ]);
        const hooks = recorder();
        const result = await session(model, hooks.sink).turn("look", new AbortController().signal);
        expect(result.text).toBe("Found it.");
        expect(hooks.events.map((payload) => payload.hook_event_name)).toContain("SubagentStart");
        // The child's first request carries only its brief, not the parent's turn.
        const childPrompt = JSON.stringify(prompts[1]);
        expect(childPrompt).toContain("Read notes.md");
        expect(childPrompt).not.toContain('"look"');
        // Its turns are a sidechain: not in the main history rows.
        const rows = lines.flatMap(decodeClaudeLine);
        expect(rows.some((row) => row.body.includes("secret sauce") && row.kind === "text")).toBe(false);
    });

    it("stops on an interruption, closes the open call, and marks it in the history", async () => {
        const stop = new AbortController();
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                stop.abort();
                throw new DOMException("aborted", "AbortError");
            }
        });
        const hooks = recorder();
        const result = await session(model, hooks.sink).turn("go", stop.signal);
        expect(result.interrupted).toBe(true);
        expect(lines.flatMap(decodeClaudeLine).at(-1)).toMatchObject({ kind: "marker", subject: "interrupted" });
        expect(hooks.events.at(-1)?.hook_event_name).toBe("Stop");
    });

    it("compacts a long conversation into a summary and marks the boundary", async () => {
        const { model, prompts } = scripted([{ text: "first" }, { text: "SUMMARY: did first" }, { text: "second" }]);
        const native = new NativeSession({
            ...(session(model, recorder().sink) as unknown as { options: object }).options,
            compactAtChars: 60
        } as ConstructorParameters<typeof NativeSession>[0]);
        await native.turn("one", new AbortController().signal);
        await native.turn("two", new AbortController().signal);
        expect(JSON.stringify(native.history())).toContain("SUMMARY: did first");
        expect(lines.flatMap(decodeClaudeLine).some((row) => row.subject === "compacted")).toBe(true);
        expect(prompts).toHaveLength(3);
    });

    it("switches model mid-session", async () => {
        const first = scripted([{ text: "a" }]);
        const second = scripted([{ text: "b" }]);
        const native = session(first.model, recorder().sink);
        await native.turn("1", new AbortController().signal);
        native.setModel(second.model, "other/model");
        expect((await native.turn("2", new AbortController().signal)).text).toBe("b");
        expect(JSON.stringify(second.prompts[0])).toContain("other/model");
    });
});
