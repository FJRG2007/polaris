/**
 * What goes out on each wire: the Anthropic SSE events in the order Anthropic
 * sends them, the stop reasons free-claude-code maps, OpenAI's chunks, the
 * error envelopes and the model routing. All pure.
 */

import { describe, expect, it } from "vitest";
import {
    AnthropicStreamWriter,
    aggregateMessage,
    anthropicUsage,
    sseFrame,
    stopReason,
    type SseEvent
} from "@/lib/polar/compat/anthropic-stream";
import { ChatStreamWriter, aggregateCompletion, chunkFrame } from "@/lib/polar/compat/openai-stream";
import {
    anthropicErrorBody,
    errorStatus,
    isCompatError,
    openaiErrorBody,
    providerError,
    refusalError
} from "@/lib/polar/compat/errors";
import { POLAR_ROUTING_DEFAULTS, type PolarRouting } from "@/lib/polar/routing";
import { choiceFor, routeFor, routeReasoning } from "@/lib/polar/compat/route-model";

type Part = Parameters<AnthropicStreamWriter["part"]>[0];

const USAGE = {
    inputTokens: 100,
    outputTokens: 20,
    inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 10, noCacheTokens: 60 }
};

function run(parts: Part[], finishReason: "stop" | "tool-calls" | "length" = "stop", thinking = true) {
    const writer = new AnthropicStreamWriter({ model: "claude-opus-5-5", inputTokens: 7, thinking, id: "msg_1" });
    const events: SseEvent[] = [...writer.start()];
    for (const part of parts) events.push(...writer.part(part));
    events.push(...writer.finish({ finishReason, usage: USAGE }));
    return events;
}

const shape = (events: SseEvent[]) =>
    events.map((event) => {
        const delta = (event.data.delta as { type?: string } | undefined)?.type;
        const block = (event.data.content_block as { type?: string } | undefined)?.type;
        return [event.event, block ?? delta].filter(Boolean).join(":");
    });

describe("the Anthropic event stream", () => {
    it("opens with message_start and ping, and names back the model asked for", () => {
        const [start, ping] = new AnthropicStreamWriter({ model: "claude-opus-5-5", inputTokens: 7, thinking: true }).start();
        expect(start!.event).toBe("message_start");
        expect(start!.data.message).toMatchObject({
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-5-5",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 1 }
        });
        expect((start!.data.message as { id: string }).id).toMatch(/^msg_/);
        expect(ping).toEqual({ event: "ping", data: { type: "ping" } });
        expect(sseFrame(ping!)).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    });

    it("streams thinking with its signature, then text, then a tool call", () => {
        const events = run(
            [
                { type: "reasoning-start", id: "r" },
                { type: "reasoning-delta", id: "r", text: "Hmm." },
                { type: "reasoning-delta", id: "r", text: "", providerMetadata: { anthropic: { signature: "sig" } } },
                { type: "reasoning-end", id: "r" },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", text: "Reading." },
                { type: "text-end", id: "t" },
                { type: "tool-input-start", id: "toolu_1", toolName: "Read" },
                { type: "tool-input-delta", id: "toolu_1", delta: '{"file_path":' },
                { type: "tool-input-delta", id: "toolu_1", delta: '"a.ts"}' },
                { type: "tool-input-end", id: "toolu_1" },
                { type: "tool-call", toolCallId: "toolu_1", toolName: "Read", input: { file_path: "a.ts" } }
            ] as Part[],
            "tool-calls"
        );
        expect(shape(events)).toEqual([
            "message_start",
            "ping",
            "content_block_start:thinking",
            "content_block_delta:thinking_delta",
            "content_block_delta:signature_delta",
            "content_block_stop",
            "content_block_start:text",
            "content_block_delta:text_delta",
            "content_block_stop",
            "content_block_start:tool_use",
            "content_block_delta:input_json_delta",
            "content_block_delta:input_json_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]);
        expect(events.filter((e) => e.event === "content_block_start").map((e) => e.data.index)).toEqual([0, 1, 2]);
        expect(events[9]!.data.content_block).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: {} });
        expect(events.at(-2)!.data).toEqual({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }
        });

        const message = aggregateMessage(events);
        expect(message).toMatchObject({
            id: "msg_1",
            model: "claude-opus-5-5",
            stop_reason: "tool_use",
            content: [
                { type: "thinking", thinking: "Hmm.", signature: "sig" },
                { type: "text", text: "Reading." },
                { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }
            ]
        });
    });

    it("sends a tool call that was not streamed as one whole delta", () => {
        const events = run(
            [{ type: "tool-call", toolCallId: "c1", toolName: "Bash", input: { command: "ls" } }] as Part[],
            "stop"
        );
        expect(shape(events).slice(2)).toEqual([
            "content_block_start:tool_use",
            "content_block_delta:input_json_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]);
        // A turn that called a tool is tool_use whatever the provider said.
        expect((events.at(-2)!.data.delta as { stop_reason: string }).stop_reason).toBe("tool_use");
    });

    it("keeps thinking from a client that turned it off, and passes redacted thinking through", () => {
        const hidden = run(
            [
                { type: "reasoning-start", id: "r" },
                { type: "reasoning-delta", id: "r", text: "secret" },
                { type: "reasoning-end", id: "r" },
                { type: "text-delta", id: "t", text: "Hi" }
            ] as Part[],
            "stop",
            false
        );
        expect(shape(hidden).slice(2, 5)).toEqual(["content_block_start:text", "content_block_delta:text_delta", "content_block_stop"]);
        const redacted = run(
            [
                { type: "reasoning-start", id: "r", providerMetadata: { anthropic: { redactedData: "opaque" } } },
                { type: "reasoning-delta", id: "r", text: "" },
                { type: "reasoning-end", id: "r" }
            ] as Part[]
        );
        expect(redacted[2]!.data.content_block).toEqual({ type: "redacted_thinking", data: "opaque" });
    });

    it("maps stop reasons as free-claude-code does", () => {
        expect(stopReason("stop")).toBe("end_turn");
        expect(stopReason("length")).toBe("max_tokens");
        expect(stopReason("tool-calls")).toBe("tool_use");
        expect(stopReason("content-filter")).toBe("end_turn");
        expect(stopReason("stop", { raw: "stop_sequence" })).toBe("stop_sequence");
        expect(stopReason("other")).toBe("end_turn");
    });

    it("ends with an error event and nothing after it", () => {
        const writer = new AnthropicStreamWriter({ model: "m", inputTokens: 1, thinking: true });
        writer.start();
        writer.part({ type: "text-delta", id: "t", text: "Hi" } as Part);
        expect(writer.error(providerError(Object.assign(new Error("x"), { statusCode: 529 })))).toEqual([
            {
                event: "error",
                data: { type: "error", error: { type: "overloaded_error", message: expect.any(String) } }
            }
        ]);
        expect(writer.finish({ finishReason: "stop", usage: {} })).toEqual([]);
    });

    it("leaves usage uncached when the provider reports no cache", () => {
        expect(anthropicUsage({ inputTokens: 50, outputTokens: 5 }, 9)).toEqual({ input_tokens: 50, output_tokens: 5 });
        expect(anthropicUsage({}, 9)).toEqual({ input_tokens: 9, output_tokens: 0 });
    });
});

describe("the OpenAI chunk stream", () => {
    it("streams role, text, reasoning, a tool call, the finish and the usage", () => {
        const writer = new ChatStreamWriter({ model: "gpt-x", inputTokens: 3, includeUsage: true, id: "chatcmpl-1", created: 1 });
        const frames = [
            ...writer.start(),
            ...writer.part({ type: "reasoning-delta", id: "r", text: "think" } as Part),
            ...writer.part({ type: "text-delta", id: "t", text: "Hello" } as Part),
            ...writer.part({ type: "tool-input-start", id: "call_1", toolName: "read" } as Part),
            ...writer.part({ type: "tool-input-delta", id: "call_1", delta: '{"p":1}' } as Part),
            ...writer.part({ type: "tool-call", toolCallId: "call_1", toolName: "read", input: { p: 1 } } as Part),
            ...writer.finish({ finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 4 } })
        ];
        const deltas = frames.map((frame) =>
            frame === "[DONE]" ? frame : ((frame.choices as { delta?: unknown }[])[0]?.delta ?? frame.usage)
        );
        expect(deltas).toEqual([
            { role: "assistant", content: "" },
            { reasoning_content: "think" },
            { content: "Hello" },
            { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] },
            { tool_calls: [{ index: 0, function: { arguments: '{"p":1}' } }] },
            {},
            {
                prompt_tokens: 10,
                completion_tokens: 4,
                total_tokens: 14,
                prompt_tokens_details: { cached_tokens: 0 },
                completion_tokens_details: { reasoning_tokens: 0 }
            },
            "[DONE]"
        ]);
        expect((frames[5] as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason).toBe("tool_calls");
        expect((frames[1] as { usage: unknown }).usage).toBeNull();
        expect(chunkFrame("[DONE]")).toBe("data: [DONE]\n\n");

        const completion = aggregateCompletion(frames, { total_tokens: 14 });
        expect(completion).toMatchObject({
            object: "chat.completion",
            model: "gpt-x",
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: "Hello",
                        reasoning_content: "think",
                        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"p":1}' } }]
                    },
                    finish_reason: "tool_calls"
                }
            ]
        });
    });
});

describe("the error envelopes", () => {
    it("map each kind of provider refusal to the type and status a client acts on", () => {
        const failing = (statusCode: number, body?: object) =>
            Object.assign(new Error("x"), { statusCode, responseBody: body ? JSON.stringify(body) : undefined });
        const cases: [unknown, string, number][] = [
            [failing(401), "permission_error", 403],
            [failing(402), "billing_error", 402],
            [failing(429), "rate_limit_error", 429],
            [failing(503), "overloaded_error", 529],
            [failing(500), "api_error", 500],
            [failing(400), "invalid_request_error", 400]
        ];
        for (const [error, type, status] of cases) {
            const mapped = providerError(error);
            expect(mapped.type).toBe(type);
            expect(errorStatus(mapped, "anthropic")).toBe(status);
        }
        const overloaded = { type: "overloaded_error" as const, message: "busy" };
        expect(errorStatus(overloaded, "anthropic")).toBe(529);
        expect(errorStatus(overloaded, "openai")).toBe(503);
    });

    it("never forwards what the provider said", () => {
        const error = Object.assign(new Error("account acme-corp key sk-live-123 refused"), { statusCode: 401 });
        expect(JSON.stringify(anthropicErrorBody(providerError(error)))).not.toContain("acme");
    });

    it("shapes both envelopes", () => {
        const error = refusalError("no_key");
        expect(anthropicErrorBody(error)).toEqual({ type: "error", error: { type: "permission_error", message: error.message } });
        expect(openaiErrorBody(error)).toEqual({ error: { message: error.message, type: "permission_error", param: null, code: null } });
        expect(error.message).toContain("No model key is set up in Polaris");
        expect(isCompatError(error)).toBe(true);
        expect(isCompatError({ type: "text", message: "x", model: "y" })).toBe(false);
    });
});

describe("routing a model id", () => {
    const options = [
        { provider: "openrouter", models: [{ model: "qwen/qwen3-coder" }, { model: "deepseek/r1" }] },
        { provider: "anthropic", models: [{ model: "claude-sonnet-4-5" }] }
    ];
    const target = (provider: string, model: string, reasoning = "inherit") =>
        ({ provider, model, reasoning, keyId: null }) as PolarRouting["defaultModel"] & object;
    const routing: PolarRouting = {
        ...POLAR_ROUTING_DEFAULTS,
        tiers: { fable: null, opus: target("openrouter", "deepseek/r1", "high"), haiku: null, sonnet: null },
        defaultModel: target("openrouter", "qwen/qwen3-coder")
    };

    it("lands a provider/model on that model, in every gateway spelling", () => {
        for (const id of ["openrouter/qwen/qwen3-coder", "anthropic/openrouter/qwen/qwen3-coder"]) {
            const route = routeFor(id, routing, options);
            expect(route).toMatchObject({ via: "direct", choice: { provider: "openrouter", model: "qwen/qwen3-coder" } });
        }
        // Anthropic's own slug is a provider here, and wins over the gateway prefix.
        expect(routeFor("anthropic/claude-sonnet-4-5", routing, options)).toMatchObject({
            via: "direct",
            choice: { provider: "anthropic", model: "claude-sonnet-4-5" }
        });
        const off = routeFor("claude-3-freecc-no-thinking/openrouter/deepseek/r1", routing, options);
        expect(off).toMatchObject({ via: "direct", forceOff: true });
        expect(routeReasoning(off as never, "high")).toBe("none");
    });

    it("lands a tier on its override, with its own effort", () => {
        const route = routeFor("claude-opus-5-5", routing, options);
        expect(route).toMatchObject({ via: "tier", preference: "high", choice: { model: "deepseek/r1" } });
        expect(routeReasoning(route as never, "low")).toBe("high");
    });

    it("lands a tier with no override on the default model, the client's effort by default", () => {
        const route = routeFor("claude-haiku-5-5", routing, options);
        expect(route).toMatchObject({ via: "default", preference: "client", choice: { model: "qwen/qwen3-coder" } });
        expect(routeReasoning(route as never, "low")).toBe("low");
    });

    it("lands anything else on Automatic, at the intelligence the effort implies", () => {
        const route = routeFor("gpt-5", POLAR_ROUTING_DEFAULTS, options);
        expect(route).toMatchObject({ via: "automatic", choice: { provider: "auto", model: "auto" } });
        expect(choiceFor(route as never, "high").intelligence).toBe("deep");
        expect(choiceFor(route as never, undefined).intelligence).toBe("balanced");
    });

    it("refuses a provider/model nobody here serves", () => {
        expect(routeFor("groq/llama-9", routing, options)).toBe("unknown_model");
    });
});
