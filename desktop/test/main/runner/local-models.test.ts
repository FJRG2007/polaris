import { describe, expect, it } from "vitest";
import type { RunnerFrame } from "@/main/runner/connection";
import * as local from "@/main/runner/local-models";

const TURN_ID = "7d4f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c";

function turn(host: string) {
    return {
        v: 1,
        type: "chat.turn" as const,
        turnId: TURN_ID,
        model: null,
        system: "You are Polar.",
        messages: [{ role: "user" as const, text: "hi" }],
        effort: null,
        mcp: null,
        local: { server: "ollama" as const, host, model: "llama3.2:3b" }
    };
}

function streamOf(lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
            controller.close();
        }
    });
    return new Response(body, { status: 200 });
}

async function settle(sent: RunnerFrame[], kinds: string[]): Promise<void> {
    for (let i = 0; i < 50 && !sent.some((frame) => frame.type === "chat.event" && kinds.includes(frame.event.kind)); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("LAN addresses", () => {
    it("keeps private IP literals only", () => {
        expect(local.isPrivateLanHost("192.168.1.20")).toBe(true);
        expect(local.isPrivateLanHost("10.0.0.5")).toBe(true);
        expect(local.isPrivateLanHost("172.16.4.4")).toBe(true);
        expect(local.isPrivateLanHost("fd12:3456::1")).toBe(true);
        expect(local.isPrivateLanHost("172.32.0.1")).toBe(false);
        expect(local.isPrivateLanHost("8.8.8.8")).toBe(false);
        expect(local.isPrivateLanHost("127.0.0.1")).toBe(false);
        expect(local.isPrivateLanHost("nas.local")).toBe(false);
        expect(local.cleanLanHosts([" 192.168.1.20 ", "192.168.1.20", "203.0.113.9"])).toEqual(["192.168.1.20"]);
    });

    it("lets a turn dial loopback or an address the person added, nothing else", () => {
        expect(local.hostAllowed("loopback", [])).toBe(true);
        expect(local.hostAllowed("192.168.1.20", [])).toBe(false);
        expect(local.hostAllowed("192.168.1.20", ["192.168.1.20"])).toBe(true);
        expect(local.hostAllowed("203.0.113.9", ["203.0.113.9"])).toBe(false);
    });

    it("dials the standard port of each server", () => {
        expect(local.serverUrl("ollama", "loopback")).toBe("http://127.0.0.1:11434");
        expect(local.serverUrl("lmstudio", "loopback")).toBe("http://127.0.0.1:1234");
        expect(local.serverUrl("vllm", "10.0.0.5")).toBe("http://10.0.0.5:8000");
        expect(local.serverUrl("llamacpp", "fd12::1")).toBe("http://[fd12::1]:8080");
    });
});

describe("detectLocalServers", () => {
    it("reads Ollama's tags and an OpenAI-style listing, and skips what does not answer", async () => {
        const asked: string[] = [];
        const fetcher = (async (url: string) => {
            asked.push(url);
            if (url === "http://127.0.0.1:11434/api/tags") return Response.json({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }] });
            if (url === "http://127.0.0.1:1234/v1/models") return Response.json({ data: [{ id: "qwen2.5-7b-instruct" }] });
            if (url === "http://127.0.0.1:8000/v1/models") return new Response("nope", { status: 404 });
            throw new Error("refused");
        }) as unknown as typeof fetch;
        const found = await local.detectLocalServers([], fetcher);
        expect(found).toEqual([
            { server: "ollama", host: "loopback", models: [{ id: "llama3.2:3b" }] },
            { server: "lmstudio", host: "loopback", models: [{ id: "qwen2.5-7b-instruct" }] }
        ]);
        expect(asked.every((url) => url.startsWith("http://127.0.0.1:"))).toBe(true);
    });

    it("never probes a public address even when one is listed", async () => {
        const asked: string[] = [];
        const fetcher = (async (url: string) => {
            asked.push(url);
            throw new Error("refused");
        }) as unknown as typeof fetch;
        await local.detectLocalServers(["8.8.8.8", "192.168.1.20"], fetcher);
        expect(asked.some((url) => url.includes("8.8.8.8"))).toBe(false);
        expect(asked.some((url) => url.includes("192.168.1.20:11434"))).toBe(true);
    });
});

describe("readStreamLine", () => {
    it("reads content, reasoning, finish and usage", () => {
        expect(local.readStreamLine('data: {"choices":[{"delta":{"content":"Hi"}}]}')).toEqual({ text: "Hi" });
        expect(local.readStreamLine('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}')).toEqual({ reasoning: "hmm" });
        expect(local.readStreamLine('data: {"choices":[{"delta":{},"finish_reason":"length"}]}')).toEqual({ finish: "length" });
        expect(local.readStreamLine('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}')).toEqual({ usage: { input: 5, output: 2 } });
        expect(local.readStreamLine("data: [DONE]")).toBe("done");
        expect(local.readStreamLine(": keep-alive")).toBeNull();
    });
});

describe("LocalChat", () => {
    it("streams a turn as chat events in order", async () => {
        const sent: RunnerFrame[] = [];
        let body = "";
        const host = new local.LocalChat({
            send: (frame) => (sent.push(frame), true),
            lanHosts: () => [],
            fetch: (async (url: string, init: RequestInit) => {
                expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
                body = String(init.body);
                return streamOf(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n', 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n', "data: [DONE]\n"]);
            }) as unknown as typeof fetch
        });
        expect(host.handle(turn("loopback"))).toBe(true);
        await settle(sent, ["finish"]);
        expect(JSON.parse(body).messages).toEqual([{ role: "system", content: "You are Polar." }, { role: "user", content: "hi" }]);
        const events = sent.map((frame) => (frame.type === "chat.event" ? [frame.seq, frame.event] : null));
        expect(events).toEqual([[0, { kind: "text", text: "Hel" }], [1, { kind: "text", text: "lo" }], [2, { kind: "finish", reason: "stop" }]]);
    });

    it("refuses a host the person never added, without dialing it", async () => {
        const sent: RunnerFrame[] = [];
        let dialed = false;
        const host = new local.LocalChat({
            send: (frame) => (sent.push(frame), true),
            lanHosts: () => [],
            fetch: (async () => ((dialed = true), new Response(""))) as unknown as typeof fetch
        });
        host.handle(turn("192.168.1.20"));
        await settle(sent, ["error"]);
        expect(dialed).toBe(false);
        expect(sent[0]).toMatchObject({ type: "chat.event", event: { kind: "error", code: "not-installed" } });
    });

    it("leaves a Claude turn to the Claude chat", () => {
        const host = new local.LocalChat({ send: () => true, lanHosts: () => [] });
        const { local: _local, ...claude } = turn("loopback");
        expect(host.handle(claude)).toBe(false);
    });
});

describe("local tool calls", () => {
    it("adds up a streamed call and reads its arguments", () => {
        const first = local.readStreamLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_tasks","arguments":"{\\"li"}}]}}]}');
        const second = local.readStreamLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mit\\":5}"}}]},"finish_reason":"tool_calls"}]}');
        expect(first).toMatchObject({ calls: [{ index: 0, id: "c1", name: "list_tasks" }] });
        expect(second).toMatchObject({ finish: "tool-calls" });
        const deltas = [...(first as { calls: local.ToolCallDelta[] }).calls, ...(second as { calls: local.ToolCallDelta[] }).calls];
        expect(local.collectToolCalls(deltas, TURN_ID)).toEqual([{ kind: "tool-call", callId: "c1", name: "list_tasks", input: { limit: 5 } }]);
    });

    it("gives a call with broken arguments an empty input and an id when it had none", () => {
        expect(local.collectToolCalls([{ index: 2, name: "x", arguments: "{oops" }], TURN_ID)).toEqual([
            { kind: "tool-call", callId: `${TURN_ID}-2`, name: "x", input: {} }
        ]);
    });

    it("sends the conversation with its calls and results in the OpenAI shape", () => {
        const base = turn("loopback");
        const messages = local.chatMessages({
            ...base,
            local: {
                ...base.local,
                conversation: [
                    { role: "user", text: "tasks?" },
                    { role: "assistant", text: "", calls: [{ callId: "c1", name: "list_tasks", input: "{}" }] },
                    { role: "tool", callId: "c1", text: "[]" }
                ]
            }
        });
        expect(messages).toEqual([
            { role: "system", content: "You are Polar." },
            { role: "user", content: "tasks?" },
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "c1", content: "[]" }
        ]);
    });

    it("names why a server refused", () => {
        expect(local.readRefusal(400, '{"error":"llama3 does not support tools"}')).toBe("tools");
        expect(local.readRefusal(404, '{"error":"model \\"x\\" not found, try pulling it first"}')).toBe("model-missing");
        expect(local.readRefusal(400, '{"error":{"message":"No models loaded. Please load a model"}}')).toBe("model-missing");
        expect(local.readRefusal(429, "")).toBe("rate-limited");
        expect(local.readRefusal(500, "boom")).toBe("failed");
    });

    it("asks again without tools when the model does not take them, and ends with the calls it asked for", async () => {
        const sent: RunnerFrame[] = [];
        const bodies: Record<string, unknown>[] = [];
        const host = new local.LocalChat({
            send: (frame) => (sent.push(frame), true),
            lanHosts: () => [],
            fetch: (async (_url: string, init: RequestInit) => {
                bodies.push(JSON.parse(String(init.body)));
                if (bodies.length === 1) return new Response('{"error":"does not support tools"}', { status: 400 });
                return streamOf(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n']);
            }) as unknown as typeof fetch
        });
        const base = turn("loopback");
        host.handle({ ...base, local: { ...base.local, tools: [{ name: "list_tasks", parameters: { type: "object" } }] } });
        await settle(sent, ["finish"]);
        expect(bodies[0]!.tools).toEqual([{ type: "function", function: { name: "list_tasks", parameters: { type: "object" } } }]);
        expect(bodies[1]!.tools).toBeUndefined();
        expect(sent.map((frame) => (frame.type === "chat.event" ? frame.event.kind : null))).toEqual(["text", "finish"]);
    });

    it("emits the calls a turn asked for and finishes on tool-calls", async () => {
        const sent: RunnerFrame[] = [];
        const host = new local.LocalChat({
            send: (frame) => (sent.push(frame), true),
            lanHosts: () => [],
            fetch: (async () =>
                streamOf([
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_tasks","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n'
                ])) as unknown as typeof fetch
        });
        const base = turn("loopback");
        host.handle({ ...base, local: { ...base.local, tools: [{ name: "list_tasks", parameters: {} }] } });
        await settle(sent, ["finish"]);
        expect(sent.map((frame) => (frame.type === "chat.event" ? frame.event : null))).toEqual([
            { kind: "tool-call", callId: "c1", name: "list_tasks", input: {} },
            { kind: "finish", reason: "tool-calls" }
        ]);
    });

    it("says the server is unreachable when nothing answers at its port", async () => {
        const sent: RunnerFrame[] = [];
        const host = new local.LocalChat({
            send: (frame) => (sent.push(frame), true),
            lanHosts: () => [],
            fetch: (async () => {
                throw new TypeError("fetch failed");
            }) as unknown as typeof fetch
        });
        host.handle(turn("loopback"));
        await settle(sent, ["error"]);
        expect(sent[0]).toMatchObject({ event: { kind: "error", code: "unreachable" } });
    });
});
