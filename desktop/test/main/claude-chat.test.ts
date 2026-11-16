import { describe, expect, it } from "vitest";
import { claudeChatOptions, claudeFailureCode, mapClaudeMessage, type MapState } from "@/main/claude-chat";

const turn = {
    claudePath: "/toolchain/claude/1/bin/claude",
    cwd: "/tmp/turn",
    model: "sonnet",
    system: "You are Polar.",
    effort: null,
    mcp: { url: "https://polaris.example.test/api/mcp", token: "fixture-token" },
    env: { PATH: "/toolchain/node/bin" }
};

describe("claudeChatOptions", () => {
    it("runs the managed claude isolated from the machine, with only Polaris's tools", () => {
        const options = claudeChatOptions(turn);
        expect(options.pathToClaudeCodeExecutable).toBe(turn.claudePath);
        expect(options.settingSources).toEqual([]);
        expect(options.tools).toEqual([]);
        expect(options.persistSession).toBe(false);
        expect(options.allowedTools).toEqual([]);
        expect(options.permissionMode).toBe("default");
        expect(options.mcpServers).toEqual({
            polaris: { type: "http", url: turn.mcp.url, headers: { Authorization: "Bearer fixture-token" } }
        });
        expect(options.model).toBe("sonnet");
        expect("effort" in options).toBe(false);
    });

    it("has no MCP server when the turn has no tools", () => {
        expect(claudeChatOptions({ ...turn, mcp: null, model: null }).mcpServers).toEqual({});
    });
});

describe("mapClaudeMessage", () => {
    it("streams text and reasoning, and does not repeat them from the complete message", () => {
        const state: MapState = { streamed: false };
        expect(mapClaudeMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Hmm" } } }, state)).toEqual([{ kind: "reasoning", text: "Hmm" }]);
        expect(mapClaudeMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }, state)).toEqual([{ kind: "text", text: "Hi" }]);
        const complete = mapClaudeMessage(
            {
                type: "assistant",
                parent_tool_use_id: null,
                message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "t1", name: "mcp__polaris__tasks_list", input: { limit: 5 } }] }
            },
            state
        );
        expect(complete).toEqual([{ kind: "tool-call", callId: "t1", name: "tasks_list", input: { limit: 5 } }]);
    });

    it("uses the complete message when nothing streamed", () => {
        const state: MapState = { streamed: false };
        expect(mapClaudeMessage({ type: "assistant", message: { content: [{ type: "text", text: "Whole" }] } }, state)).toEqual([{ kind: "text", text: "Whole" }]);
    });

    it("maps tool results, the finish with usage, and leaves subagent traffic out", () => {
        const state: MapState = { streamed: false };
        expect(
            mapClaudeMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 tasks" }], is_error: false }] } }, state)
        ).toEqual([{ kind: "tool-result", callId: "t1", output: "3 tasks", isError: false }]);
        expect(mapClaudeMessage({ type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 4 } }, state)).toEqual([
            { kind: "finish", reason: "stop", usage: { input: 10, output: 4 } }
        ]);
        expect(mapClaudeMessage({ type: "result", subtype: "error_max_turns" }, state)).toEqual([{ kind: "finish", reason: "length" }]);
        expect(mapClaudeMessage({ type: "result", subtype: "error_during_execution" }, state)).toEqual([{ kind: "error", code: "failed" }]);
        expect(mapClaudeMessage({ type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "sub" }] } }, state)).toEqual([]);
    });
});

describe("claudeFailureCode", () => {
    it("names the failure without forwarding Claude Code's text", () => {
        expect(claudeFailureCode(new Error("spawn claude ENOENT"))).toBe("not-installed");
        expect(claudeFailureCode(new Error("Invalid API key · Please run /login"))).toBe("signed-out");
        expect(claudeFailureCode(new Error("Claude AI usage limit reached"))).toBe("rate-limited");
        expect(claudeFailureCode(new Error("boom"))).toBe("failed");
    });
});
