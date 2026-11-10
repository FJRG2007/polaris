/**
 * The Responses wire (what Codex speaks), the tool-name aliases and the
 * keep-alive: the request read into AI SDK messages, the events in
 * free-claude-code's order, names that round-trip, and a silent stream kept
 * open. All pure.
 */

import { describe, expect, it } from "vitest";
import {
    customToolNames,
    responsesReasoning,
    responsesRequestSchema,
    responsesToModelMessages,
    responsesToolChoiceOf,
    responsesToolsOf
} from "@/lib/polar/compat/responses-request";
import { SSE_COMMENT, streamBody } from "@/lib/polar/compat/stream-body";
import type { SseEvent } from "@/lib/polar/compat/anthropic-stream";
import { encodeToolNames, toolNameCodec } from "@/lib/polar/compat/tool-names";
import { ResponsesStreamWriter, aggregateResponse } from "@/lib/polar/compat/responses-stream";

type Part = Parameters<ResponsesStreamWriter["part"]>[0];

function writer(custom: string[] = []) {
    return new ResponsesStreamWriter({
        model: "gpt-5-codex",
        inputTokens: 4,
        customTools: new Set(custom),
        echo: { tools: [], tool_choice: "auto", parallel_tool_calls: true },
        id: "resp_1",
        createdAt: 1
    });
}

describe("reading a Responses request", () => {
    it("reads a Codex turn: instructions, messages, calls, outputs and reasoning", () => {
        const request = responsesRequestSchema.parse({
            model: "gpt-5-codex",
            instructions: "You are Codex.",
            input: [
                { type: "message", role: "developer", content: [{ type: "input_text", text: "Sandbox on." }] },
                { role: "user", content: [{ type: "input_text", text: "Fix it" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
                { type: "reasoning", summary: [{ type: "summary_text", text: "Look first." }], encrypted_content: "x" },
                { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":["ls"]}' },
                { type: "function_call_output", call_id: "call_1", output: "a.ts" },
                { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" },
                { type: "custom_tool_call_output", call_id: "call_2", output: "Done" }
            ],
            tools: [
                { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
                { type: "custom", name: "apply_patch", format: { type: "grammar" } },
                { type: "web_search" }
            ],
            reasoning: { effort: "high", summary: "auto" },
            store: false
        });
        const messages = responsesToModelMessages(request);
        expect(messages.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "tool", "assistant", "tool"]);
        expect(messages[3]!.content).toEqual([
            { type: "reasoning", text: "Look first." },
            { type: "tool-call", toolCallId: "call_1", toolName: "shell", input: { command: ["ls"] } }
        ]);
        expect(messages[5]!.content).toEqual([
            { type: "tool-call", toolCallId: "call_2", toolName: "apply_patch", input: { input: "*** Begin Patch" } }
        ]);
        expect(messages[6]!.content).toEqual([
            { type: "tool-result", toolCallId: "call_2", toolName: "apply_patch", output: { type: "text", value: "Done" } }
        ]);
        // Hosted tools run on OpenAI's side and are not declared.
        expect(Object.keys(responsesToolsOf(request.tools)!)).toEqual(["shell", "apply_patch"]);
        expect([...customToolNames(request.tools)]).toEqual(["apply_patch"]);
        expect(responsesReasoning(request)).toBe("high");
        expect(responsesToolChoiceOf({ type: "function", name: "shell" })).toEqual({ type: "tool", toolName: "shell" });
        expect(responsesToModelMessages({ input: "hi", instructions: null })).toEqual([{ role: "user", content: "hi" }]);
    });
});

describe("the Responses event stream", () => {
    it("emits reasoning, text and a function call in free-claude-code's order, numbered", () => {
        const stream = writer();
        const events: SseEvent[] = [
            ...stream.start(),
            ...stream.part({ type: "reasoning-delta", id: "r", text: "Think" } as Part),
            ...stream.part({ type: "reasoning-end", id: "r" } as Part),
            ...stream.part({ type: "text-delta", id: "t", text: "Hi" } as Part),
            ...stream.part({ type: "text-end", id: "t" } as Part),
            ...stream.part({ type: "tool-input-start", id: "call_1", toolName: "shell" } as Part),
            ...stream.part({ type: "tool-input-delta", id: "call_1", delta: '{"command":' } as Part),
            ...stream.part({ type: "tool-input-delta", id: "call_1", delta: '["ls"]}' } as Part),
            ...stream.part({ type: "tool-input-end", id: "call_1" } as Part),
            ...stream.part({ type: "tool-call", toolCallId: "call_1", toolName: "shell", input: { command: ["ls"] } } as Part),
            ...stream.finish({ finishReason: "tool-calls", usage: { inputTokens: 9, outputTokens: 3 } })
        ];
        expect(events.map((event) => event.event)).toEqual([
            "response.created",
            "response.output_item.added",
            "response.reasoning_text.delta",
            "response.reasoning_text.done",
            "response.output_item.done",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            "response.output_item.added",
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
            "response.output_item.done",
            "response.completed"
        ]);
        expect(events.map((event) => event.data.sequence_number)).toEqual(events.map((_, index) => index));
        expect(events.map((event) => event.data.type)).toEqual(events.map((event) => event.event));
        const created = events[0]!.data.response as Record<string, unknown>;
        expect(created).toMatchObject({ id: "resp_1", object: "response", status: "in_progress", model: "gpt-5-codex", output: [] });
        const response = aggregateResponse(events);
        expect(response).toMatchObject({
            status: "completed",
            output: [
                { type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: "Think" }] },
                { type: "message", status: "completed", content: [{ type: "output_text", text: "Hi", annotations: [] }] },
                { type: "function_call", status: "completed", call_id: "call_1", name: "shell", arguments: '{"command":["ls"]}' }
            ],
            usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } }
        });
        expect((response.output as { id: string }[])[2]!.id).toMatch(/^fc_/);
    });

    it("hands a custom tool its raw input back", () => {
        const stream = writer(["apply_patch"]);
        stream.start();
        const events = stream.part({
            type: "tool-call",
            toolCallId: "call_2",
            toolName: "apply_patch",
            input: { input: "*** Begin Patch" }
        } as Part);
        expect(events.map((event) => event.event)).toEqual([
            "response.output_item.added",
            "response.custom_tool_call_input.delta",
            "response.custom_tool_call_input.done",
            "response.output_item.done"
        ]);
        expect(events[3]!.data.item).toMatchObject({ type: "custom_tool_call", call_id: "call_2", input: "*** Begin Patch" });
    });

    it("is incomplete at the length limit, and failed after an error", () => {
        const cut = writer();
        cut.start();
        const [incomplete] = cut.finish({ finishReason: "length", usage: {} });
        expect(incomplete!.event).toBe("response.incomplete");
        expect(incomplete!.data.response).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });

        const broken = writer();
        broken.start();
        const [failed] = broken.error({ type: "overloaded_error", message: "busy" });
        expect(failed!.event).toBe("response.failed");
        expect(failed!.data.response).toMatchObject({ status: "failed", error: { type: "overloaded_error", message: "busy" } });
        expect(broken.finish({ finishReason: "stop", usage: {} })).toEqual([]);
    });
});

describe("tool names", () => {
    it("keeps portable names and aliases the rest as free-claude-code does", () => {
        const odd = "mcp__my.server__read file";
        const long = `mcp__${"x".repeat(80)}`;
        const codec = toolNameCodec(["Bash", odd, long]);
        expect(codec.encode("Bash")).toBe("Bash");
        const alias = codec.encode(odd);
        expect(alias).toMatch(/^mcp__my_server__read_file_[0-9a-f]{16}$/);
        expect(codec.encode(long)).toHaveLength(64);
        expect(codec.encode(long)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(codec.decode(alias)).toBe(odd);
        expect(codec.decode("Bash")).toBe("Bash");
        // The same names map the same way whatever their order.
        expect(toolNameCodec([long, odd]).encode(odd)).toBe(alias);
    });

    it("renames tools, the tool choice and the history", () => {
        const odd = "a.b";
        const codec = toolNameCodec([odd]);
        const encoded = encodeToolNames(
            {
                tools: { [odd]: {} as never },
                toolChoice: { type: "tool", toolName: odd },
                messages: [
                    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: odd, input: {} }] },
                    {
                        role: "tool",
                        content: [{ type: "tool-result", toolCallId: "1", toolName: odd, output: { type: "text", value: "" } }]
                    }
                ]
            },
            codec
        );
        const alias = codec.encode(odd);
        expect(Object.keys(encoded.tools!)).toEqual([alias]);
        expect(encoded.toolChoice).toEqual({ type: "tool", toolName: alias });
        expect(JSON.stringify(encoded.messages)).not.toContain('"a.b"');
    });
});

describe("keep-alive", () => {
    it("writes the keep-alive while the next frame is slow, then the frame", async () => {
        async function* slow() {
            await new Promise((resolve) => setTimeout(resolve, 60));
            yield "frame";
        }
        const body = streamBody(slow(), (frame) => `data: ${frame}\n\n`, SSE_COMMENT, 20);
        const text = await new Response(body).text();
        expect(text.startsWith(": keep-alive\n\n")).toBe(true);
        expect(text.endsWith("data: frame\n\n")).toBe(true);
        expect(text.split(": keep-alive").length - 1).toBeGreaterThanOrEqual(2);
    });
});
