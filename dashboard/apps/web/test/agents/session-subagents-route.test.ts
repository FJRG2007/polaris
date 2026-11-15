/**
 * The events route keeps what the subagent tree needs on each stored event:
 * the subagent an event fired in, its type, and the call id or transcript path
 * that pairs a launch with its end. Anything that fails its check is dropped,
 * never stored.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "00000000-0000-4000-8000-000000000001";

const recorded = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/agents/session-history", () => ({
    syncFinalSessionHistory: async () => undefined,
    syncSessionHistorySoon: async () => undefined
}));
vi.mock("@/lib/agents/session-service", () => ({
    sessionForToken: async (token: string) => (token === "good" ? { id: SESSION } : null),
    recordSessionConversation: async () => undefined,
    recordSessionTodos: async () => undefined,
    recordTaskTool: async () => undefined,
    recordReportedMode: async () => undefined,
    recordSessionEvents: async (_id: string, events: Record<string, unknown>[]) => {
        recorded.push(...events);
        return "working";
    }
}));
vi.mock("@/lib/agents/account-rotation", () => ({
    handleTurnFailure: async () => "rotated",
    noteTurnFinished: async () => undefined,
    turnAccountName: async () => null
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));

const { POST } = await import("@/app/api/agents/sessions/[id]/events/route");

function post(body: unknown) {
    return POST(
        new Request(`http://polaris.test/api/agents/sessions/${SESSION}/events`, {
            method: "POST",
            headers: { authorization: "Bearer good", "x-polaris-seq": "1700000000000000005" },
            body: JSON.stringify(body)
        }),
        { params: Promise.resolve({ id: SESSION }) }
    );
}

const BASE = { session_id: "abc123", transcript_path: "/home/agent/.claude/projects/p/abc123.jsonl", cwd: "/w" };

describe("POST /api/agents/sessions/:id/events, subagent fields", () => {
    beforeEach(() => {
        recorded.length = 0;
    });

    it("stores a launch with its call id and the type it asked for", async () => {
        await post({
            ...BASE,
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_use_id: "toolu_01",
            tool_input: { description: "Find the routes", prompt: "...", subagent_type: "Explore" }
        });
        expect(recorded).toEqual([
            {
                kind: "tool.start",
                detail: "Agent: Find the routes",
                subject: "Agent",
                agentId: null,
                agentType: "Explore",
                ref: "toolu_01"
            }
        ]);
    });

    it("stores SubagentStart as subagent.start with the agent's id and type", async () => {
        await post({ ...BASE, hook_event_name: "SubagentStart", agent_id: "agent-abc123", agent_type: "Explore" });
        expect(recorded).toEqual([
            { kind: "subagent.start", detail: "", subject: "Explore", agentId: "agent-abc123", agentType: "Explore", ref: null }
        ]);
    });

    it("stores a tool fired inside a subagent with that subagent's id", async () => {
        await post({
            ...BASE,
            hook_event_name: "PostToolUse",
            agent_id: "def456",
            agent_type: "Explore",
            tool_name: "Grep",
            tool_use_id: "toolu_02",
            tool_input: { pattern: "x" },
            tool_response: { error: "boom" }
        });
        expect(recorded[0]).toMatchObject({ kind: "tool.failed", agentId: "def456", agentType: "Explore", ref: "toolu_02" });
    });

    it("keeps SubagentStop's transcript path, and only a safe one", async () => {
        const stop = {
            ...BASE,
            hook_event_name: "SubagentStop",
            stop_hook_active: false,
            agent_id: "def456",
            agent_type: "Explore",
            last_assistant_message: "Done"
        };
        await post({ ...stop, agent_transcript_path: "~/.claude/projects/p/abc123/subagents/agent-def456.jsonl" });
        await post({ ...stop, agent_transcript_path: "/home/a/../../etc/passwd.jsonl" });
        await post({ ...stop, agent_transcript_path: "/home/a/$(reboot).jsonl" });
        expect(recorded.map((event) => event.ref)).toEqual([
            "~/.claude/projects/p/abc123/subagents/agent-def456.jsonl",
            null,
            null
        ]);
        expect(recorded[0]).toMatchObject({ kind: "subagent.end", agentId: "def456" });
    });

    it("drops an agent id or call id that fails its check", async () => {
        await post({
            ...BASE,
            hook_event_name: "PreToolUse",
            agent_id: "a b; rm -rf /",
            tool_name: "Bash",
            tool_use_id: "x".repeat(200),
            tool_input: { command: "ls" }
        });
        expect(recorded[0]).toMatchObject({ kind: "tool.start", agentId: null, agentType: null, ref: null });
    });

    it("leaves the main agent's events without subagent fields", async () => {
        await post({ ...BASE, hook_event_name: "Stop", agent_type: "reviewer" });
        expect(recorded).toEqual([
            { kind: "turn.end", detail: "", subject: "", agentId: null, agentType: null, ref: null }
        ]);
    });
});
