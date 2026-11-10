/**
 * The compatible endpoints end to end, on a fake model: who may call them,
 * what Claude Code and an OpenAI client receive, and what is recorded.
 */

import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

const state = {
    principal: null as null | { keyId: string; userId: string; scopes: string[] },
    presented: [] as (string | null)[],
    use: true,
    refusal: null as null | string,
    parts: [] as LanguageModelV4StreamPart[],
    failWith: null as null | Record<string, unknown>,
    calls: [] as Record<string, unknown>[],
    recorded: [] as Record<string, unknown>[],
    resolvedWith: [] as unknown[],
    resolveOptions: [] as unknown[],
    limit: false
};

vi.mock("@/lib/api-key-auth", () => ({
    authenticateApiKey: async (request: Request) => {
        state.presented.push(request.headers.get("authorization"));
        return request.headers.get("authorization") === "Bearer plk_good" ? state.principal : null;
    }
}));
vi.mock("@/lib/polar/access", () => ({
    polarAccessFor: async () => ({ use: state.use, spend: true, web: false, connectors: false })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/polar/router/store", async () => {
    const { POLAR_ROUTING_DEFAULTS } = await import("@/lib/polar/routing");
    return { polarRouting: async () => POLAR_ROUTING_DEFAULTS };
});

const OPTION = {
    provider: "openrouter",
    providerName: "OpenRouter",
    model: "qwen/qwen3-coder",
    name: "Qwen3 Coder",
    reasoning: true,
    attachment: false,
    contextTokens: 0,
    providerContextTokens: null,
    costInput: 1,
    costOutput: 2,
    inputs: [],
    releaseDate: null,
    outputTokens: 500
};

function fakeModel() {
    return new MockLanguageModelV4({
        doStream: async (options: Record<string, unknown>) => {
            state.calls.push(options);
            if (state.failWith) throw Object.assign(new Error("Too Many Requests for account acme"), state.failWith);
            return {
                stream: new ReadableStream({
                    start(controller) {
                        for (const part of state.parts) controller.enqueue(part);
                        controller.close();
                    }
                })
            };
        }
    });
}

vi.mock("@/lib/polar/models", () => ({
    answeredBy: <T>(resolved: T) => resolved,
    polarModelOptions: async () => [
        { provider: "openrouter", name: "OpenRouter", payers: ["own"], models: [OPTION] }
    ],
    resolvePolarModel: async (_userId: string, choice: unknown, ...rest: unknown[]) => {
        state.resolvedWith.push(choice);
        state.resolveOptions.push(rest[2]);
        if (state.refusal) return state.refusal;
        return {
            model: fakeModel(),
            option: OPTION,
            credential: { provider: "openrouter", secret: "k", source: "own", keyId: "key-1" }
        };
    }
}));
vi.mock("@/lib/polar/usage", async (actual) => ({
    ...(await actual<typeof import("@/lib/polar/usage")>()),
    recordPolarUsage: async (input: Record<string, unknown>) => void state.recorded.push(input),
    polarLimitReached: async () => (state.limit ? { used: 1, amount: 1, period: "day" } : null)
}));

const { createMessage, countTokens } = await import("@/lib/polar/compat/messages");
const { createChatCompletion } = await import("@/lib/polar/compat/chat");
const { listModels } = await import("@/lib/polar/compat/models");
const { createResponse } = await import("@/lib/polar/compat/responses");

const USAGE = {
    inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined }
};

function says(text: string): LanguageModelV4StreamPart[] {
    return [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } }
    ];
}

function post(path: string, body: unknown, headers: Record<string, string> = { "x-api-key": "plk_good" }) {
    return new Request(`http://polaris.test/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
    });
}

const ASK = {
    model: "claude-sonnet-5-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: "Hello" }]
};

/** The SSE body as its events. */
async function events(response: Response) {
    const text = await response.text();
    return text
        .trim()
        .split("\n\n")
        .map((frame) => {
            const [event, data] = frame.split("\n");
            return { event: event!.slice("event: ".length), data: JSON.parse(data!.slice("data: ".length)) };
        });
}

beforeEach(() => {
    state.principal = { keyId: "k1", userId: "u1", scopes: ["polar.use"] };
    state.presented = [];
    state.use = true;
    state.refusal = null;
    state.parts = says("Hi there");
    state.failWith = null;
    state.calls = [];
    state.recorded = [];
    state.resolvedWith = [];
    state.resolveOptions = [];
    state.limit = false;
});

describe("who may call", () => {
    it("answers a missing or wrong key with Anthropic's 401", async () => {
        const response = await createMessage(post("messages", ASK, {}));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            type: "error",
            error: { type: "authentication_error", message: expect.any(String) }
        });
    });

    it("takes the key from x-api-key or from Bearer", async () => {
        expect((await createMessage(post("messages", ASK))).status).toBe(200);
        expect((await createMessage(post("messages", ASK, { authorization: "Bearer plk_good" }))).status).toBe(200);
        expect(state.presented).toEqual(["Bearer plk_good", "Bearer plk_good"]);
    });

    it("refuses a key without polar.use, and an account Polar is not open to, with 403", async () => {
        state.principal = { keyId: "k1", userId: "u1", scopes: ["vpn.use"] };
        const scoped = await createMessage(post("messages", ASK));
        expect(scoped.status).toBe(403);
        expect((await scoped.json()).error.type).toBe("permission_error");

        state.principal = { keyId: "k1", userId: "u1", scopes: ["polar.use"] };
        state.use = false;
        const closed = await createChatCompletion(post("chat/completions", { model: "x", messages: [{ role: "user", content: "hi" }] }));
        expect(closed.status).toBe(403);
        expect(await closed.json()).toEqual({
            error: { message: expect.any(String), type: "permission_error", param: null, code: null }
        });
    });
});

describe("POST /v1/messages", () => {
    it("streams the Anthropic events, names back the model asked for, and records the answer", async () => {
        const response = await createMessage(post("messages", { ...ASK, stream: true }));
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const sent = await events(response);
        expect(sent.map((event) => event.event)).toEqual([
            "message_start",
            "ping",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]);
        expect(sent[0]!.data.message.model).toBe("claude-sonnet-5-5");
        expect(sent[3]!.data.delta).toEqual({ type: "text_delta", text: "Hi there" });
        expect(sent[5]!.data).toEqual({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 12, output_tokens: 5 }
        });
        expect(state.recorded).toEqual([
            expect.objectContaining({
                userId: "u1",
                threadId: null,
                messageId: null,
                provider: "openrouter",
                model: "qwen/qwen3-coder",
                payer: "own",
                keyId: "key-1",
                surface: "api",
                fellBack: null,
                usage: expect.objectContaining({ inputTokens: 12, outputTokens: 5 })
            })
        ]);
        // Never past what the model declares it can write.
        expect(state.calls[0]!.maxOutputTokens).toBe(500);
    });

    it("answers a non-streamed request with the message, and no tool loop runs", async () => {
        state.parts = [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "toolu_1", toolName: "Bash", input: '{"command":"ls"}' },
            { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } }
        ];
        const response = await createMessage(
            post("messages", {
                ...ASK,
                tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }]
            })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]
        });
        expect(state.calls).toHaveLength(1);
    });

    it("answers a refusal before any output with its status, not a broken stream", async () => {
        state.failWith = { statusCode: 429 };
        const response = await createMessage(post("messages", { ...ASK, stream: true }));
        expect(response.status).toBe(429);
        const body = await response.json();
        expect(body.error.type).toBe("rate_limit_error");
        expect(JSON.stringify(body)).not.toContain("acme");
    });

    it("says no model key is set up, and stops at the shared key's ceiling", async () => {
        state.refusal = "no_key";
        const missing = await createMessage(post("messages", ASK));
        expect(missing.status).toBe(403);
        expect((await missing.json()).error.message).toContain("No model key is set up in Polaris");

        state.refusal = null;
        state.limit = true;
        // The ceiling applies to the shared key only; this one is the person's own.
        expect((await createMessage(post("messages", ASK))).status).toBe(200);
    });

    it("refuses a body that is not a Messages request", async () => {
        const response = await createMessage(post("messages", { model: "x" }));
        expect(response.status).toBe(400);
        expect((await response.json()).error.type).toBe("invalid_request_error");
    });

    it("routes a tier id with no override to Automatic at the client's effort", async () => {
        await createMessage(post("messages", { ...ASK, output_config: { effort: "high" } }));
        expect(state.resolvedWith[0]).toMatchObject({ provider: "auto", model: "auto", intelligence: "deep" });
        expect(state.calls[0]!.reasoning).toBe("high");
        // The router applies the route's preference to the first step.
        expect(state.resolveOptions[0]).toEqual({ keyId: null, reasoning: "client", fallBack: true });
    });

    it("answers HEAD and OPTIONS probes behind the key check", async () => {
        const { compatProbe } = await import("@/lib/polar/compat/auth");
        const probe = compatProbe("POST, HEAD, OPTIONS", "anthropic");
        const ok = await probe(new Request("http://polaris.test/api/v1/messages", { method: "OPTIONS", headers: { "x-api-key": "plk_good" } }));
        expect(ok.status).toBe(204);
        expect(ok.headers.get("allow")).toBe("POST, HEAD, OPTIONS");
        const denied = await probe(new Request("http://polaris.test/api/v1/messages", { method: "HEAD" }));
        expect(denied.status).toBe(401);
    });

    it("sends tool names a provider refuses as aliases, and gives the client its own back", async () => {
        const odd = "mcp__my.server__read file";
        const { toolNameCodec } = await import("@/lib/polar/compat/tool-names");
        const alias = toolNameCodec([odd]).encode(odd);
        state.parts = [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "toolu_9", toolName: alias, input: "{}" },
            { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } }
        ];
        const response = await createMessage(
            post("messages", { ...ASK, tools: [{ name: odd, input_schema: { type: "object", properties: {} } }] })
        );
        const sent = state.calls[0]!.tools as { name: string }[];
        expect(sent.map((entry) => entry.name)).toEqual([alias]);
        expect((await response.json()).content[0]).toMatchObject({ type: "tool_use", name: odd });
    });
});

describe("the other endpoints", () => {
    it("counts tokens", async () => {
        const response = await countTokens(post("messages/count_tokens", ASK));
        expect(await response.json()).toEqual({ input_tokens: expect.any(Number) });
    });

    it("streams OpenAI chunks with usage when asked", async () => {
        const response = await createChatCompletion(
            post("chat/completions", {
                model: "openrouter/qwen/qwen3-coder",
                messages: [{ role: "user", content: "hi" }],
                stream: true,
                stream_options: { include_usage: true }
            })
        );
        const lines = (await response.text()).trim().split("\n\n");
        expect(lines.at(-1)).toBe("data: [DONE]");
        const usage = JSON.parse(lines.at(-2)!.slice("data: ".length));
        expect(usage).toMatchObject({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } });
        const first = JSON.parse(lines[0]!.slice("data: ".length));
        expect(first).toMatchObject({ object: "chat.completion.chunk", model: "openrouter/qwen/qwen3-coder" });
        expect(state.resolvedWith[0]).toMatchObject({ provider: "openrouter", model: "qwen/qwen3-coder" });
    });

    it("answers a plain chat completion", async () => {
        const response = await createChatCompletion(
            post("chat/completions", { model: "gpt-5", messages: [{ role: "user", content: "hi" }] })
        );
        expect(await response.json()).toMatchObject({
            object: "chat.completion",
            model: "gpt-5",
            choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 5 }
        });
    });

    it("answers the Responses API streamed and not, and refuses previous_response_id", async () => {
        const ask = { model: "gpt-5-codex", input: "hi", store: false };
        const streamed = await createResponse(post("responses", { ...ask, stream: true }, { authorization: "Bearer plk_good" }));
        const names = (await streamed.text())
            .trim()
            .split("\n\n")
            .map((frame) => frame.split("\n")[0]!.slice("event: ".length));
        expect(names[0]).toBe("response.created");
        expect(names.at(-1)).toBe("response.completed");
        expect(names).toContain("response.output_text.delta");

        const plain = await createResponse(post("responses", ask, { authorization: "Bearer plk_good" }));
        expect(await plain.json()).toMatchObject({
            object: "response",
            status: "completed",
            model: "gpt-5-codex",
            output: [{ type: "message", content: [{ type: "output_text", text: "Hi there" }] }],
            usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 }
        });

        const chained = await createResponse(
            post("responses", { ...ask, previous_response_id: "resp_x" }, { authorization: "Bearer plk_good" })
        );
        expect(chained.status).toBe(400);
        expect((await chained.json()).error.type).toBe("invalid_request_error");
    });

    it("lists the tier ids and every provider/model", async () => {
        const response = await listModels(
            new Request("http://polaris.test/api/v1/models", { headers: { authorization: "Bearer plk_good" } })
        );
        const list = await response.json();
        expect(list.data.map((model: { id: string }) => model.id)).toEqual([
            "claude-fable-5-2",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "anthropic/openrouter/qwen/qwen3-coder",
            "claude-3-freecc-no-thinking/openrouter/qwen/qwen3-coder",
            "openrouter/qwen/qwen3-coder"
        ]);
        expect(list.data[6]).toMatchObject({ object: "model", type: "model", owned_by: "openrouter" });
        expect(list).toMatchObject({ object: "list", has_more: false, first_id: "claude-fable-5-2" });
    });
});
