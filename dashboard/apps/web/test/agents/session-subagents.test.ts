/**
 * A Code session's subagents as a tree, decoded from the hook payloads Claude
 * Code posts: the launching Agent/Task call, SubagentStart, the tool events
 * that carry the subagent's agent_id, and SubagentStop.
 */

import { describe, expect, it } from "vitest";
import { decodeSubagentTree, subagentDuration } from "@/lib/agents/session-subagents";

const SESSION = { session_id: "00000000-0000-4000-8000-000000000001", transcript_path: "/home/agent/.claude/projects/x/s.jsonl" };

const launch = (id: string, type: string, description: string, tool = "Agent") => ({
    ...SESSION,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_use_id: id,
    tool_input: { description, prompt: "Do the thing", subagent_type: type }
});
const launched = (id: string, response: unknown = { status: "completed" }, tool = "Agent") => ({
    ...SESSION,
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_use_id: id,
    tool_response: response
});
const start = (agent: string, type: string) => ({ ...SESSION, hook_event_name: "SubagentStart", agent_id: agent, agent_type: type });
const stop = (agent: string, type: string, path = `/home/agent/.claude/projects/x/subagents/agent-${agent}.jsonl`) => ({
    ...SESSION,
    hook_event_name: "SubagentStop",
    agent_id: agent,
    agent_type: type,
    agent_transcript_path: path,
    stop_hook_active: false
});
const tool = (agent: string, name: string, id: string, phase: "PreToolUse" | "PostToolUse", response?: unknown) => ({
    ...SESSION,
    hook_event_name: phase,
    agent_id: agent,
    agent_type: "Explore",
    tool_name: name,
    tool_use_id: id,
    tool_input: { pattern: "x" },
    ...(response === undefined ? {} : { tool_response: response })
});

const timed = (payloads: unknown[]) => payloads.map((payload, index) => ({ payload, at: 1000 + index * 1000 }));

describe("decodeSubagentTree", () => {
    it("pairs each launch with its start, its steps and its stop", () => {
        const tree = decodeSubagentTree(
            timed([
                launch("toolu_1", "Explore", "Find the API routes"),
                launch("toolu_2", "Plan", "Plan the change"),
                start("a1", "Explore"),
                start("a2", "Plan"),
                tool("a1", "Grep", "toolu_g", "PreToolUse"),
                tool("a1", "Grep", "toolu_g", "PostToolUse", { matches: 3 }),
                tool("a1", "Read", "toolu_r", "PreToolUse"),
                tool("a1", "Read", "toolu_r", "PostToolUse", { error: "ENOENT" }),
                stop("a1", "Explore"),
                launched("toolu_1")
            ])
        );
        expect(tree).toHaveLength(2);
        expect(tree[0]).toMatchObject({
            id: "a1",
            agentId: "a1",
            toolUseId: "toolu_1",
            type: "Explore",
            description: "Find the API routes",
            status: "done",
            startedAt: 1000,
            endedAt: 9000,
            transcriptPath: "/home/agent/.claude/projects/x/subagents/agent-a1.jsonl"
        });
        expect(tree[0]!.steps).toEqual([
            { tool: "Grep", id: "toolu_g", status: "done", startedAt: 5000, endedAt: 6000 },
            { tool: "Read", id: "toolu_r", status: "failed", startedAt: 7000, endedAt: 8000 }
        ]);
        expect(tree[1]).toMatchObject({ id: "a2", type: "Plan", status: "running", steps: [] });
        expect(subagentDuration(tree[0]!, 99_000)).toBe(8000);
        expect(subagentDuration(tree[1]!, 10_000)).toBe(8000);
    });

    it("reads the earlier Task tool, and a failed launch as failed", () => {
        const tree = decodeSubagentTree(
            timed([launch("toolu_t", "general-purpose", "Old CLI", "Task"), launched("toolu_t", { error: "denied" }, "Task")])
        );
        expect(tree).toEqual([expect.objectContaining({ id: "toolu_t", agentId: null, status: "failed" })]);
    });

    it("marks what still runs as stopped when the turn ends", () => {
        const tree = decodeSubagentTree(
            timed([
                launch("toolu_1", "Explore", "Look"),
                start("a1", "Explore"),
                tool("a1", "Bash", "toolu_b", "PreToolUse"),
                { ...SESSION, hook_event_name: "Stop" }
            ])
        );
        expect(tree[0]).toMatchObject({ status: "stopped", endedAt: 4000 });
        expect(tree[0]!.steps[0]).toMatchObject({ status: "failed", endedAt: 4000 });
    });

    it("keeps a subagent whose launch it never saw, and drops what it cannot read", () => {
        const tree = decodeSubagentTree(
            timed([
                null,
                "text",
                { hook_event_name: 7 },
                tool("ghost", "Grep", "toolu_x", "PreToolUse"),
                start("a9", "Explore"),
                stop("a9", "Explore", "../../etc/passwd")
            ])
        );
        expect(tree).toEqual([
            expect.objectContaining({ id: "a9", type: "Explore", description: "", status: "done", transcriptPath: null })
        ]);
    });
});
