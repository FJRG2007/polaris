/**
 * The agent's tool calls as Polar Code's steps: read in the order they were
 * made, each with its own result, and a call the agent described again stored
 * with what really ran.
 */

import { describe, expect, it } from "vitest";
import { codeToolSteps, stepCounts, stepKindOf } from "@/lib/polar/code-steps";
import { AcpNormalizer } from "@/lib/agents/acp/normalize";
import { stepEvents } from "@/lib/agents/acp/session-driver";

const row = (id: string, kind: string, subject: string, ref: string, body: string, at: string) => ({
    id,
    kind,
    subject,
    ref,
    body,
    at: `2026-11-25T10:00:${at}.000Z`
});

describe("codeToolSteps", () => {
    it("pairs each call with its result, in call order", () => {
        const rows = [
            row("1", "tool", "Bash", "a", "npm test", "00"),
            row("2", "tool", "Read", "b", "src/plan.ts", "01"),
            row("3", "result", "", "b", "file body", "02"),
            row("4", "result", "error", "a", "1 failed", "05")
        ];
        const steps = codeToolSteps(rows, true);
        expect(steps.map(({ id, step }) => [id, step.kind, step.input, step.output, step.state, step.ms])).toEqual([
            ["1", "command", "npm test", "1 failed", "failed", 5000],
            ["2", "read", "src/plan.ts", "file body", "done", 1000]
        ]);
    });

    it("runs while the session is live and has ended after", () => {
        const rows = [row("1", "tool", "Edit", "a", "src/x.ts", "00")];
        expect(codeToolSteps(rows, true)[0]!.step.state).toBe("running");
        expect(codeToolSteps(rows, false)[0]!.step.state).toBe("ended");
    });

    it("names kinds from tool names and agents' titles", () => {
        expect(stepKindOf("`npm test`")).toBe("command");
        expect(stepKindOf("Edit src/plan.ts")).toBe("edit");
        expect(stepKindOf("apply_patch")).toBe("edit");
        expect(stepKindOf("mcp__x__y")).toBe("other");
        const counts = stepCounts(
            codeToolSteps(
                [row("1", "tool", "Bash", "a", "ls", "00"), row("2", "tool", "Bash", "b", "pwd", "01"), row("3", "tool", "Write", "c", "a.ts", "02")],
                false
            ).map(({ step }) => step)
        );
        expect(counts).toEqual([
            { kind: "command", count: 2 },
            { kind: "edit", count: 1 }
        ]);
    });
});

describe("ACP tool calls", () => {
    it("applies a later update's title and input to the call row", () => {
        const normalizer = new AcpNormalizer("s1");
        const first = normalizer.push({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", status: "pending" });
        expect(first).toMatchObject([{ vendorId: "t1:call", kind: "tool", subject: "Terminal", body: "" }]);
        const update = normalizer.push({
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            title: "`npm test`",
            rawInput: { command: "npm test" },
            status: "in_progress"
        });
        expect(update).toMatchObject([{ vendorId: "t1:call", subject: "`npm test`", body: "npm test", replace: true }]);
        // Nothing new: no row.
        expect(normalizer.push({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })).toEqual([]);
        const done = normalizer.push({
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            rawOutput: "12 passed"
        });
        expect(done).toMatchObject([{ kind: "result", body: "12 passed" }]);
        expect(stepEvents([...first, ...update, ...done], normalizer)).toEqual([
            { kind: "tool.start", detail: "", subject: "Terminal" },
            { kind: "tool.end", detail: "", subject: "`npm test`" }
        ]);
    });

    it("reports a failed call as tool.failed", () => {
        const normalizer = new AcpNormalizer("s1");
        const rows = normalizer.push({
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            title: "Run",
            rawInput: { command: "exit 1" },
            status: "failed",
            rawOutput: "exit 1"
        });
        expect(stepEvents(rows, normalizer).map((event) => event.kind)).toEqual(["tool.start", "tool.failed"]);
    });
});
