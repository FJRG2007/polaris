/**
 * A Polar Chat turn on the person's own Claude subscription, run by the
 * managed Claude Code through the official Claude Agent SDK - the path
 * OpenCode calls "Claude Agent" (`plugin/provider/claude-agent`).
 *
 * The SDK drives the `claude` the toolchain installed, signed in with the
 * person's own account on this computer. Like OpenCode's `query-options.ts`,
 * the turn is isolated from whatever the machine has configured: no settings
 * files, no hooks, no skills, none of Claude Code's own tools. The only tools
 * are Polaris's, reached as one HTTP MCP server with a token that lives as long
 * as the turn, and every call waits for the person's approval through
 * `canUseTool` unless the server already allowed it.
 *
 * The SDK is loaded from the toolchain at run time rather than bundled, so a
 * pin moves with the app's update like every other tool. This file holds the
 * two pure halves - the options and the stream mapping - which is everything
 * that can be wrong without a subscription to hand.
 */

/** The chat events this sends, as `runner-protocol.ts` defines them
 *  (`runnerChatEventSchema`); the server validates every one on arrival. */
export type ChatEvent =
    | { kind: "text"; text: string; }
    | { kind: "reasoning"; text: string; }
    | { kind: "tool-call"; callId: string; name: string; input: Record<string, unknown>; }
    | { kind: "tool-result"; callId: string; output: string; isError: boolean; }
    | { kind: "approval"; approvalId: string; callId: string; name: string; input: Record<string, unknown>; }
    | { kind: "finish"; reason: "stop" | "length" | "cancelled" | "tool-calls"; usage?: { input: number; output: number; }; }
    | { kind: "error"; code: "signed-out" | "rate-limited" | "not-installed" | "failed"; };

/** The MCP server name Polaris's tools are listed under, so the agent sees
 *  them as `mcp__polaris__<tool>`. */
export const POLARIS_MCP_NAME = "polaris";

export interface ChatTurnInput {
    readonly claudePath: string;
    readonly cwd: string;
    readonly model: string | null;
    readonly system: string;
    readonly effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
    readonly mcp: { url: string; token: string; } | null;
    readonly env: Record<string, string>;
}

/** The SDK `Options` for one turn. Mirrors OpenCode's isolation choices. */
export function claudeChatOptions(input: ChatTurnInput): Record<string, unknown> {
    const options: Record<string, unknown> = {
        pathToClaudeCodeExecutable: input.claudePath,
        cwd: input.cwd,
        env: input.env,
        systemPrompt: input.system,
        settingSources: [],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        skills: [],
        tools: [],
        persistSession: false,
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        permissionMode: "default",
        allowedTools: [],
        mcpServers: input.mcp
            ? { [POLARIS_MCP_NAME]: { type: "http", url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` } } }
            : {}
    };
    if (input.model) options.model = input.model;
    if (input.effort) options.effort = input.effort;
    return options;
}

/** The tool name Polar knows, from the SDK's `mcp__polaris__<name>`. */
export function polarisToolName(sdkName: string): string {
    const prefix = `mcp__${POLARIS_MCP_NAME}__`;
    return sdkName.startsWith(prefix) ? sdkName.slice(prefix.length) : sdkName;
}

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; };
type SdkMessage = {
    type: string;
    subtype?: string;
    parent_tool_use_id?: string | null;
    event?: { type: string; delta?: { type: string; text?: string; thinking?: string; }; };
    message?: { id?: string; content?: Block[] | string; };
    usage?: { input_tokens?: number; output_tokens?: number; };
    error?: unknown;
};

/** What a stream of one turn has already said, so a complete assistant
 *  message does not repeat text that arrived as deltas. */
export interface MapState {
    streamed: boolean;
}

function resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown; }).text) : "")).join("");
    return "";
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One SDK message as Polar chat events. Subagent traffic is left out: the
 *  chat shows the turn's own answer, as OpenCode does. */
export function mapClaudeMessage(message: SdkMessage, state: MapState): ChatEvent[] {
    if (message.parent_tool_use_id) return [];
    if (message.type === "stream_event") {
        const delta = message.event?.type === "content_block_delta" ? message.event.delta : undefined;
        if (delta?.type === "text_delta" && delta.text) {
            state.streamed = true;
            return [{ kind: "text", text: delta.text }];
        }
        if (delta?.type === "thinking_delta" && delta.thinking) {
            state.streamed = true;
            return [{ kind: "reasoning", text: delta.thinking }];
        }
        return [];
    }
    if (message.type === "assistant" && Array.isArray(message.message?.content)) {
        const events: ChatEvent[] = [];
        for (const block of message.message.content) {
            if (block.type === "tool_use" && block.id && block.name) events.push({ kind: "tool-call", callId: block.id, name: polarisToolName(block.name), input: asRecord(block.input) });
            else if (!state.streamed && block.type === "text" && block.text) events.push({ kind: "text", text: block.text });
            else if (!state.streamed && block.type === "thinking" && block.thinking) events.push({ kind: "reasoning", text: block.thinking });
        }
        // The next assistant message streams afresh.
        state.streamed = false;
        return events;
    }
    if (message.type === "user" && Array.isArray(message.message?.content)) {
        return message.message.content
            .filter((block) => block.type === "tool_result" && block.tool_use_id)
            .map((block) => ({ kind: "tool-result" as const, callId: block.tool_use_id!, output: resultText(block.content).slice(0, 256_000), isError: block.is_error === true }));
    }
    if (message.type === "result") {
        if (message.subtype === "success") {
            const usage = message.usage ? { input: message.usage.input_tokens ?? 0, output: message.usage.output_tokens ?? 0 } : undefined;
            return [{ kind: "finish", reason: "stop", ...(usage ? { usage } : {}) }];
        }
        if (message.subtype === "error_max_turns") return [{ kind: "finish", reason: "length" }];
        return [{ kind: "error", code: "failed" }];
    }
    return [];
}

/** An SDK or process failure as the one word the dashboard translates. The
 *  text is Claude Code's own and is never forwarded. */
export function claudeFailureCode(error: unknown): Extract<ChatEvent, { kind: "error"; }>["code"] {
    const text = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found|no such file/i.test(text)) return "not-installed";
    if (/rate.?limit|429|usage limit/i.test(text)) return "rate-limited";
    if (/log ?in|logged out|not authenticated|authentication|401|\/login/i.test(text)) return "signed-out";
    return "failed";
}
