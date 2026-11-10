/**
 * The compatible API reads a client's request into the AI SDK's messages the
 * way free-claude-code converts them: tool results ahead of the turn's text,
 * the tool's name found from the call, images and documents kept, thinking
 * replayed with its signature, and the effort the client asked for.
 */

import { describe, expect, it } from "vitest";
import {
    clientReasoning,
    effortForBudget,
    messagesRequestSchema,
    systemMessages,
    toModelMessages,
    toolChoiceOf,
    toolOutput,
    toolsOf
} from "@/lib/polar/compat/anthropic-request";
import {
    chatReasoning,
    chatRequestSchema,
    chatToModelMessages,
    chatToolChoiceOf
} from "@/lib/polar/compat/openai-request";
import { countRequestTokens } from "@/lib/polar/compat/tokens";

describe("Anthropic Messages to AI SDK messages", () => {
    it("reads a whole Claude Code turn: tool use, tool result, image and thinking", () => {
        const request = messagesRequestSchema.parse({
            model: "claude-sonnet-5-5",
            max_tokens: 1024,
            system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
            messages: [
                { role: "user", content: "List the files" },
                {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "Use ls.", signature: "sig-1" },
                        { type: "redacted_thinking", data: "opaque" },
                        { type: "text", text: "Running ls." },
                        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }
                    ]
                },
                {
                    role: "user",
                    content: [
                        { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" },
                        { type: "text", text: "And this picture?" },
                        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
                        { type: "image", source: { type: "url", url: "https://example.com/a.png" } }
                    ]
                }
            ],
            unknown_beta_field: true
        });
        expect(systemMessages(request.system)).toEqual([
            {
                role: "system",
                content: "You are Claude Code.",
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
            }
        ]);
        const messages = toModelMessages(request.messages);
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
        expect(messages[1]!.content).toEqual([
            { type: "reasoning", text: "Use ls.", providerOptions: { anthropic: { signature: "sig-1" } } },
            { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "opaque" } } },
            { type: "text", text: "Running ls." },
            { type: "tool-call", toolCallId: "toolu_1", toolName: "Bash", input: { command: "ls" } }
        ]);
        expect(messages[2]!.content).toEqual([
            {
                type: "tool-result",
                toolCallId: "toolu_1",
                toolName: "Bash",
                output: { type: "text", value: "a.txt\nb.txt" }
            }
        ]);
        const user = messages[3]!.content as { type: string; image?: unknown; mediaType?: string }[];
        expect(user[0]).toEqual({ type: "text", text: "And this picture?" });
        expect(user[1]).toEqual({ type: "image", image: "iVBOR", mediaType: "image/png" });
        expect(user[2]!.image).toBeInstanceOf(URL);
    });

    it("carries a failed tool as error text and a tool's screenshot as a file", () => {
        expect(toolOutput({ content: "boom", is_error: true })).toEqual({ type: "error-text", value: "boom" });
        expect(
            toolOutput({ content: [{ type: "text", text: "no such file" }], is_error: true })
        ).toEqual({ type: "error-text", value: "no such file" });
        expect(
            toolOutput({
                content: [
                    { type: "text", text: "screenshot" },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }
                ]
            })
        ).toEqual({
            type: "content",
            value: [
                { type: "text", text: "screenshot" },
                { type: "file", data: { type: "data", data: "AAA" }, mediaType: "image/png" }
            ]
        });
    });

    it("reads documents: a PDF as a file, a plain-text one as text", () => {
        const [message] = toModelMessages([
            {
                role: "user",
                content: [
                    {
                        type: "document",
                        source: { type: "base64", media_type: "application/pdf", data: "JVBER" },
                        title: "spec.pdf"
                    },
                    { type: "document", source: { type: "text", media_type: "text/plain", data: "notes" } }
                ]
            }
        ]);
        expect(message!.content).toEqual([
            { type: "file", data: "JVBER", mediaType: "application/pdf", filename: "spec.pdf" },
            { type: "text", text: "notes" }
        ]);
    });

    it("declares tools without execute, and maps tool_choice", () => {
        const tools = toolsOf([
            { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } }
        ])!;
        expect(Object.keys(tools)).toEqual(["Read"]);
        expect((tools.Read as { execute?: unknown }).execute).toBeUndefined();
        expect(toolChoiceOf({ type: "any" })).toBe("required");
        expect(toolChoiceOf({ type: "auto" })).toBe("auto");
        expect(toolChoiceOf({ type: "none" })).toBe("none");
        expect(toolChoiceOf({ type: "tool", name: "Read" })).toEqual({ type: "tool", toolName: "Read" });
    });

    it("reads the effort the client asked for", () => {
        expect(clientReasoning({})).toBeUndefined();
        expect(clientReasoning({ thinking: { type: "disabled" } })).toBe("none");
        expect(clientReasoning({ thinking: { type: "adaptive" } })).toBeUndefined();
        expect(clientReasoning({ thinking: { type: "adaptive" }, output_config: { effort: "high" } })).toBe("high");
        expect(clientReasoning({ output_config: { effort: "none" } })).toBe("none");
        expect(clientReasoning({ thinking: { type: "enabled", budget_tokens: 31_999 } })).toBe("xhigh");
        expect(effortForBudget(1_024)).toBe("low");
        expect(effortForBudget(4_000)).toBe("medium");
        expect(effortForBudget(10_000)).toBe("high");
    });

    it("refuses a body that is not a Messages request", () => {
        expect(messagesRequestSchema.safeParse({ messages: [] }).success).toBe(false);
        expect(
            messagesRequestSchema.safeParse({ model: "x", messages: [{ role: "system", content: "x" }] }).success
        ).toBe(false);
    });

    it("estimates tokens as free-claude-code does without its encoder", () => {
        const count = countRequestTokens({
            system: "x".repeat(40),
            messages: [{ role: "user", content: "y".repeat(80) }],
            tools: []
        });
        // 10 for the system, 4 for its overhead, 20 for the text, 4 per message.
        expect(count).toBe(38);
    });
});

describe("OpenAI Chat Completions to AI SDK messages", () => {
    it("reads system, tool calls, tool results and images", () => {
        const request = chatRequestSchema.parse({
            model: "openrouter/some-model",
            messages: [
                { role: "developer", content: "Be brief." },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Read it" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }
                    ]
                },
                {
                    role: "assistant",
                    content: null,
                    reasoning_content: "Use the tool.",
                    tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } }]
                },
                { role: "tool", tool_call_id: "call_1", content: "contents" }
            ],
            reasoning_effort: "high",
            tool_choice: { type: "function", function: { name: "read" } }
        });
        const messages = chatToModelMessages(request.messages);
        expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
        expect(messages[2]!.content).toEqual([
            { type: "reasoning", text: "Use the tool." },
            { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { p: "a" } }
        ]);
        expect(messages[3]!.content).toEqual([
            { type: "tool-result", toolCallId: "call_1", toolName: "read", output: { type: "text", value: "contents" } }
        ]);
        expect(chatReasoning(request)).toBe("high");
        expect(chatToolChoiceOf(request.tool_choice)).toEqual({ type: "tool", toolName: "read" });
    });
});
