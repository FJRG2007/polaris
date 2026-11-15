/**
 * A subagent's own transcript is the one file outside the checkout the session
 * reader opens, and only at the exact place Claude Code writes it. Its lines
 * are all `isSidechain`, which the main transcript's decoder skips; here they
 * are the conversation.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/session-service", () => ({ sessionPlacement: async () => null }));
vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: async () => ({ code: 0, output: "" }) }));
vi.mock("@/lib/agents/session-ports", () => ({ withContainerPorts: async () => null }));

const files = await import("@/lib/agents/session-files");
const { decodeClaudeLine } = await import("@/lib/agents/transcript-decoders");

const PATH = "~/.claude/projects/-work-repo/5f2c/subagents/agent-a1b2.jsonl";

function line(type: "user" | "assistant", uuid: string, content: unknown): string {
    return JSON.stringify({
        type,
        uuid,
        isSidechain: true,
        timestamp: "2026-11-15T10:00:00.000Z",
        message: { role: type, content }
    });
}

/** A machine that answers the chunk script with the given file. */
function machine(file: string | null) {
    const scripts: string[] = [];
    const run = vi.fn(async (_sessionId: string, script: string) => {
        scripts.push(script);
        if (file === null) return { code: 0, output: "polaris-transcript: missing\n" };
        const from = Number(/tail -c \+(\d+)/.exec(script)?.[1] ?? "1") - 1;
        const bytes = Buffer.from(file, "utf8");
        const chunk = bytes.subarray(from, from + 11_000).toString("base64");
        return { code: 0, output: `polaris-transcript: chunk ${bytes.length}\n${chunk}\n` };
    });
    return { run, scripts };
}

describe("subagentTranscriptPath", () => {
    it("allows a subagent transcript under the Claude projects folder", () => {
        for (const path of [
            PATH,
            "/root/.claude/projects/-work-repo/5f2c/subagents/agent-a1b2.jsonl",
            "/home/agent/.claude-acct1/projects/p/subagents/agent-x.jsonl"
        ])
            expect(files.subagentTranscriptPath(path)).toBe(path);
    });

    it("refuses anything else", () => {
        for (const path of [
            null,
            "",
            "~/.claude/projects/p/s.jsonl",
            "~/.claude/projects/p/subagents/agent.json",
            "~/.claude/projects/../../etc/subagents/x.jsonl",
            "~/.claude/projects/p/./subagents/x.jsonl",
            "/etc/passwd",
            "relative/.claude/projects/p/subagents/x.jsonl",
            "~/.claude/projects/p/subagents/x.jsonl\n",
            "~/.claude/projects/p q/subagents/x.jsonl",
            "~/.claude/projects/p/subagents/$(id).jsonl",
            "~/.ssh/projects/p/subagents/x.jsonl",
            `~/.claude/projects/${"a/".repeat(600)}subagents/x.jsonl`
        ])
            expect(files.subagentTranscriptPath(path)).toBeNull();
    });
});

describe("readSubagentTranscript", () => {
    const transcript = `${[
        line("user", "u1", "Find the API routes"),
        line("assistant", "a1", [
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "route" } }
        ]),
        line("assistant", "a2", [{ type: "text", text: "There are two." }])
    ].join("\n")}\n`;

    it("decodes the sidechain lines the main decoder skips", async () => {
        expect(decodeClaudeLine(line("user", "u1", "Find the API routes"))).toEqual([]);
        const { run } = machine(transcript);
        const answer = await files.readSubagentTranscript("s1", PATH, run);
        expect(answer.kind).toBe("rows");
        if (answer.kind !== "rows") return;
        expect(answer.truncated).toBe(false);
        expect(answer.rows.map((row) => [row.role, row.kind, row.kind === "tool" ? row.subject : row.body])).toEqual([
            ["user", "text", "Find the API routes"],
            ["agent", "text", "Looking."],
            ["agent", "tool", "Grep"],
            ["agent", "text", "There are two."]
        ]);
    });

    it("never asks the machine for a path outside the allowance", async () => {
        const { run } = machine(transcript);
        expect(await files.readSubagentTranscript("s1", "/etc/passwd", run)).toEqual({ kind: "missing" });
        expect(await files.readSubagentTranscript("s1", null, run)).toEqual({ kind: "missing" });
        expect(run).not.toHaveBeenCalled();
    });

    it("says when the file is gone, and when the machine did not answer", async () => {
        expect(await files.readSubagentTranscript("s1", PATH, machine(null).run)).toEqual({ kind: "missing" });
        const broken = vi.fn(async () => {
            throw new Error("socket closed");
        });
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await files.readSubagentTranscript("s1", PATH, broken)).toEqual({ kind: "unavailable" });
        quiet.mockRestore();
    });

    it("cuts a long transcript and says so", async () => {
        const long = `${Array.from({ length: files.MAX_SUBAGENT_ROWS + 20 }, (_, index) =>
            line("assistant", `a${index}`, [{ type: "text", text: `step ${index}` }])
        ).join("\n")}\n`;
        const answer = await files.readSubagentTranscript("s1", PATH, machine(long).run);
        expect(answer.kind).toBe("rows");
        if (answer.kind !== "rows") return;
        expect(answer.rows.length).toBeLessThanOrEqual(files.MAX_SUBAGENT_ROWS);
        expect(answer.truncated).toBe(true);
    });
});
