/**
 * A Chat turn's whole life on the ACP driver, from frames the way Claude
 * Code's adapter (claude-agent-acp 0.99.1) sends them: a turn the agent starts
 * on its own after its prompt ended (a Monitor or background task waking it),
 * a Stop the agent does not honour, the agent's process going away, and an
 * AskUserQuestion form.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { FakePipe, noSleep } from "./fake-pipe";
import { describe, expect, it, vi } from "vitest";
import { acpBinding } from "@/lib/agents/acp/providers";
import type { HistoryRow } from "@/lib/agents/transcript-decoders";
import { AGENT_EXITED, AcpSessionDriver, type DriverDeps } from "@/lib/agents/acp/session-driver";

type Frame = Record<string, unknown>;

const FRAMES: Frame[] = readFileSync(join(__dirname, "fixtures", "agents", "claude.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Frame);
const SESSION = (FRAMES[1]!.result as { sessionId: string }).sessionId;

const update = (body: Frame): Frame => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: SESSION, update: body }
});

/**
 * What the live session showed after its prompt had answered `end_turn`
 * with a Monitor still armed: the agent woke, ran steps and wrote a message,
 * with no prompt open and nothing marking the end.
 */
const AUTONOMOUS: Frame[] = [
    update({ sessionUpdate: "tool_call", toolCallId: "toolu_bg1", title: "Read build.log", kind: "read", status: "pending", rawInput: { file_path: "/work/repo/build.log" } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_bg1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }),
    update({ sessionUpdate: "agent_message_chunk", messageId: "msg_bg1", content: { type: "text", text: "The build finished cleanly." } })
];

/** Claude's agent: answers setup from its recording, a prompt with
 *  `end_turn` unless told to hold it, and nothing to a cancel when told so. */
function agent(options: { hold?: boolean; ignoreCancel?: boolean; onPrompt?: (pipe: FakePipe, id: unknown) => void } = {}) {
    let promptId: unknown = null;
    return (frame: Frame, pipe: FakePipe): void => {
        const answer = (result: unknown) => pipe.emit({ jsonrpc: "2.0", id: frame.id, result });
        switch (frame.method) {
            case "initialize":
                return answer(FRAMES[0]!.result);
            case "session/new":
                return answer(FRAMES[1]!.result);
            case "session/cancel":
                if (!options.ignoreCancel && promptId !== null)
                    pipe.emit({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
                return;
            case "session/prompt":
                promptId = frame.id;
                if (options.onPrompt) return options.onPrompt(pipe, frame.id);
                if (options.hold) return;
                return answer({ stopReason: "end_turn" });
        }
    };
}

function harness(pipe: FakePipe, extra: Partial<DriverDeps> = {}) {
    const rows: HistoryRow[] = [];
    const events: { kind: string; detail: string }[] = [];
    const signals: string[] = [];
    const ended: string[] = [];
    const deps: DriverDeps = {
        session: async () => ({ binding: acpBinding("claude")!, workdir: "/work/repo", vendorSessionId: null }),
        version: async () => "99.0.0",
        start: async () => undefined,
        pipe: async () => pipe,
        storeRows: async (_id, stored) => {
            rows.push(...stored);
        },
        recordEvents: async (_id, list) => {
            events.push(...list.map(({ kind, detail }) => ({ kind, detail })));
        },
        recordVendorId: async () => undefined,
        permission: () => async () => null,
        signal: async (_id, signal) => {
            signals.push(signal);
        },
        turnEnded: async (id) => {
            ended.push(id);
        },
        touch: () => undefined,
        log: () => undefined,
        pipeOptions: { sleep: noSleep, minPollMs: 0, maxPollMs: 0 },
        sleep: noSleep,
        cycleQuietMs: 30,
        cycleIdleMs: 200,
        stopGraceMs: 30,
        ...extra
    };
    const kinds = () => events.map((event) => event.kind);
    return { driver: new AcpSessionDriver("session-1", deps), rows, events, kinds, signals, ended };
}

describe("a turn the agent starts on its own", () => {
    it("is working while it runs and ends when the agent goes quiet, then the queue goes", async () => {
        const pipe = new FakePipe(agent());
        // Quiet long enough that the check below sees the turn still open: the
        // steps reach the events a tick after the frames.
        const { driver, kinds, rows, ended } = harness(pipe, { cycleQuietMs: 300 });
        await driver.prompt("Watch the build");
        await driver.settled();
        expect(kinds()).toEqual(["prompt", "turn.end"]);
        expect(ended).toEqual(["session-1"]);

        for (const frame of AUTONOMOUS) pipe.emit(frame);
        await vi.waitFor(() => expect(kinds()).toContain("tool.start"), { interval: 5 });
        expect(driver.busy).toBe(true);
        await vi.waitFor(() => expect(kinds()).toEqual(["prompt", "turn.end", "tool.start", "tool.end", "turn.end"]), {
            timeout: 3000
        });
        expect(driver.busy).toBe(false);
        expect(ended).toEqual(["session-1", "session-1"]);
        expect(rows.at(-1)).toMatchObject({ role: "agent", kind: "text", body: "The build finished cleanly." });
        driver.close();
    });

    it("waits longer while a step it started is still open", async () => {
        const pipe = new FakePipe(agent());
        const { driver, kinds } = harness(pipe, { cycleQuietMs: 20, cycleIdleMs: 150 });
        await driver.prompt("Watch");
        await driver.settled();
        pipe.emit(AUTONOMOUS[0]!);
        await vi.waitFor(() => expect(kinds()).toContain("tool.start"));
        await new Promise((resolve) => setTimeout(resolve, 60));
        // Past the quiet wait, short of the open-step one.
        expect(kinds().filter((kind) => kind === "turn.end")).toHaveLength(1);
        await vi.waitFor(() => expect(kinds().filter((kind) => kind === "turn.end")).toHaveLength(2), { timeout: 2000 });
        driver.close();
    });

    it("is taken over by a message sent meanwhile, with one end for both", async () => {
        const pipe = new FakePipe(agent());
        const { driver, kinds } = harness(pipe);
        await driver.prompt("one");
        await driver.settled();
        pipe.emit(AUTONOMOUS[0]!);
        await vi.waitFor(() => expect(driver.busy).toBe(true));
        await driver.prompt("two");
        await driver.settled();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(kinds()).toEqual(["prompt", "turn.end", "tool.start", "prompt", "turn.end"]);
        driver.close();
    });

    it("is stopped at once by Stop, as an interrupted turn", async () => {
        const pipe = new FakePipe(agent());
        const { driver, kinds, rows } = harness(pipe, { cycleQuietMs: 5_000 });
        await driver.prompt("one");
        await driver.settled();
        pipe.emit(AUTONOMOUS[0]!);
        await vi.waitFor(() => expect(driver.busy).toBe(true));
        await expect(driver.cancel()).resolves.toBe(true);
        expect(driver.busy).toBe(false);
        expect(kinds()).toEqual(["prompt", "turn.end", "tool.start", "turn.end"]);
        expect(rows.at(-1)).toMatchObject({ kind: "marker", subject: "interrupted" });
        expect(pipe.received.some((frame) => frame.method === "session/cancel")).toBe(true);
        driver.close();
    });

    it("fails, and leaves the session idle, when the agent's process ends in it", async () => {
        const pipe = new FakePipe(agent());
        const { driver, events, ended } = harness(pipe, { cycleQuietMs: 5_000 });
        await driver.prompt("one");
        await driver.settled();
        pipe.emit(AUTONOMOUS[0]!);
        await vi.waitFor(() => expect(driver.busy).toBe(true));
        pipe.exitCode = 137;
        await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: "turn.failed", detail: AGENT_EXITED }));
        expect(driver.busy).toBe(false);
        // A failed turn holds the queue.
        expect(ended).toEqual(["session-1"]);
        driver.close();
    });
});

describe("Stop", () => {
    it("leaves working at once, then signals INT, TERM and closes an agent that does not stop", async () => {
        const pipe = new FakePipe(agent({ hold: true, ignoreCancel: true }));
        const { driver, kinds, signals, rows } = harness(pipe);
        await driver.prompt("Long job");
        await vi.waitFor(() => expect(pipe.received.some((frame) => frame.method === "session/prompt")).toBe(true));
        await driver.cancel();
        // Recorded before the agent answered anything.
        expect(kinds()).toEqual(["prompt", "turn.end"]);
        expect(driver.busy).toBe(true);
        await vi.waitFor(() => expect(signals).toEqual(["INT", "TERM"]));
        await vi.waitFor(() => expect(driver.busy).toBe(false));
        await driver.settled();
        // Ended as the person stopped it, not as a failure.
        expect(kinds()).toEqual(["prompt", "turn.end"]);
        expect(rows.at(-1)).toMatchObject({ kind: "marker", subject: "interrupted" });
        driver.close();
    });

    it("signals nothing when the agent honours the cancel, and a message after it goes", async () => {
        const pipe = new FakePipe(agent({ hold: true }));
        const { driver, kinds, signals, ended } = harness(pipe);
        await driver.prompt("Long job");
        await vi.waitFor(() => expect(pipe.received.some((frame) => frame.method === "session/prompt")).toBe(true));
        await driver.cancel();
        await driver.settled();
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(signals).toEqual([]);
        expect(ended).toEqual(["session-1"]);
        await driver.prompt("next");
        expect(kinds()).toEqual(["prompt", "turn.end", "prompt"]);
        driver.close();
    });

    it("records the stop even when no turn of this driver's is running", async () => {
        const pipe = new FakePipe(agent());
        const { driver, kinds } = harness(pipe);
        await driver.cancel();
        expect(kinds()).toEqual(["turn.end"]);
        driver.close();
    });
});

describe("the agent's process ending mid-turn", () => {
    it("fails the turn in Polaris's words, leaves it idle, and the next message starts the agent again", async () => {
        const pipe = new FakePipe(agent({ hold: true }));
        let starts = 0;
        const { driver, events, ended } = harness(pipe, {
            start: async () => {
                starts += 1;
            }
        });
        await driver.prompt("Long job");
        await vi.waitFor(() => expect(pipe.received.some((frame) => frame.method === "session/prompt")).toBe(true));
        pipe.exitCode = 1;
        await vi.waitFor(() => expect(driver.busy).toBe(false));
        await driver.settled();
        expect(events).toEqual([
            { kind: "prompt", detail: "" },
            { kind: "turn.failed", detail: AGENT_EXITED }
        ]);
        expect(ended).toEqual([]);
        pipe.exitCode = null;
        pipe.generation = "1700000000000000001-43";
        await vi.waitFor(async () => {
            await expect(driver.prompt("again").then(() => "sent", () => "refused")).resolves.toBe("sent");
        });
        expect(starts).toBe(2);
        driver.close();
    });
});

describe("AskUserQuestion over ACP", () => {
    /** The adapter's form for one single choice and one multiple choice
     *  (`askUserQuestionsToCreateRequest`). */
    const FORM = {
        mode: "form",
        sessionId: SESSION,
        toolCallId: "toolu_ask",
        message: "Please answer the following questions.",
        requestedSchema: {
            type: "object",
            properties: {
                question_0: {
                    type: "string",
                    title: "Framework",
                    description: "Which framework?",
                    oneOf: [{ const: "React", title: "React", description: "Components" }, { const: "Vue", title: "Vue" }]
                },
                question_0_custom: { type: "string", title: "Other" },
                question_1: {
                    type: "array",
                    title: "Checks",
                    description: "Which checks?",
                    items: { anyOf: [{ const: "Lint", title: "Lint" }, { const: "Tests", title: "Tests" }] }
                },
                question_1_custom: { type: "string", title: "Other" }
            }
        }
    };

    it("advertises form elicitation, asks on the session's card and answers in the adapter's fields", async () => {
        const asked: unknown[] = [];
        const pipe = new FakePipe(
            agent({
                onPrompt: (fake) => fake.emit({ jsonrpc: "2.0", id: 900, method: "elicitation/create", params: FORM })
            })
        );
        const { driver, kinds } = harness(pipe, {
            ask: async (_id, request) => {
                asked.push(request);
                return { status: "allow", answer: { answers: { "Which framework?": "React", "Which checks?": "Lint, Run e2e" } } };
            }
        });
        await driver.prompt("Set it up");
        const init = pipe.received.find((frame) => frame.method === "initialize") as { params: { clientCapabilities: Frame } };
        expect(init.params.clientCapabilities.elicitation).toEqual({ form: {} });
        await vi.waitFor(() => expect(pipe.received.some((frame) => frame.id === 900 && "result" in frame)).toBe(true));
        const reply = pipe.received.find((frame) => frame.id === 900) as { result: unknown };
        expect(reply.result).toEqual({
            action: "accept",
            content: { question_0: "React", question_1: ["Lint"], question_1_custom: "Run e2e" }
        });
        expect(asked[0]).toMatchObject({
            tool: "AskUserQuestion",
            carriesReason: false,
            input: {
                questions: [
                    { question: "Which framework?", header: "Framework", multiSelect: false },
                    { question: "Which checks?", header: "Checks", multiSelect: true }
                ]
            }
        });
        expect(kinds()).toEqual(["prompt", "question", "tool.start"]);
        driver.close();
    });

    it("cancels a form that is not a question Polaris can draw", async () => {
        const pipe = new FakePipe(
            agent({
                onPrompt: (fake) =>
                    fake.emit({
                        jsonrpc: "2.0",
                        id: 901,
                        method: "elicitation/create",
                        params: { mode: "form", sessionId: SESSION, message: "Token?", requestedSchema: { type: "object", properties: { token: { type: "string" } } } }
                    })
            })
        );
        const { driver } = harness(pipe, { ask: async () => ({ status: "allow" }) });
        await driver.prompt("x");
        await vi.waitFor(() => expect(pipe.received.some((frame) => frame.id === 901 && "result" in frame)).toBe(true));
        expect((pipe.received.find((frame) => frame.id === 901) as { result: unknown }).result).toEqual({ action: "cancel" });
        driver.close();
    });

    it("does not end the agent's own turn while its question waits on the person", async () => {
        let release: (value: { status: "allow"; answer: unknown }) => void = () => undefined;
        const pipe = new FakePipe(agent());
        const { driver, kinds } = harness(pipe, {
            cycleQuietMs: 20,
            ask: () => new Promise((resolve) => (release = resolve))
        });
        await driver.prompt("one");
        await driver.settled();
        pipe.emit(AUTONOMOUS[2]!);
        pipe.emit({ jsonrpc: "2.0", id: 902, method: "elicitation/create", params: FORM });
        await vi.waitFor(() => expect(kinds()).toContain("question"));
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(kinds().filter((kind) => kind === "turn.end")).toHaveLength(1);
        release({ status: "allow", answer: { answers: { "Which framework?": "Vue" } } });
        await vi.waitFor(() => expect(kinds().filter((kind) => kind === "turn.end")).toHaveLength(2));
        driver.close();
    });
});
