/**
 * Model servers on this computer (`local-models` in `docs/runner-protocol.md`):
 * Ollama, LM Studio, vLLM and llama.cpp, found on their standard ports and
 * offered to Polar while this computer is online.
 *
 * The server never names an address to dial. The runner looks on loopback,
 * and on the LAN only at the private IP addresses the person added
 * (`local.config`), each checked here again; a turn naming any other host is
 * refused. Names are not accepted, because a name can resolve anywhere.
 */

import { isIP } from "node:net";
import type { RunnerFrame, ServerFrame } from "./connection";
import * as protocol from "../../../../dashboard/packages/core/src/runner-protocol";

type ChatEvent = protocol.RunnerChatEvent;
type ChatTurn = ServerFrame & { type: "chat.turn"; };
export type LocalServer = NonNullable<protocol.RunnerCapabilities["localModels"]>[number];

/** The host value that means this computer. */
export const LOOPBACK = "loopback";

/** Each server's standard port and the path that lists its models. */
export const LOCAL_SERVER_PORTS: Record<protocol.LocalModelServer, { port: number; list: "ollama" | "openai"; }> = {
    ollama: { port: 11434, list: "ollama" },
    lmstudio: { port: 1234, list: "openai" },
    vllm: { port: 8000, list: "openai" },
    llamacpp: { port: 8080, list: "openai" }
};

const PROBE_MS = 1500;
const TEXT_MAX = 64_000;

/** Whether `host` is an IP literal in a private, link-local or unique-local
 *  range. Loopback is not a LAN address and is answered false. Pure. */
export function isPrivateLanHost(host: string): boolean {
    const value = host.trim().toLowerCase();
    if (isIP(value) === 4) {
        const [a, b] = value.split(".").map(Number) as [number, number];
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (isIP(value) === 6) return /^f[cd][0-9a-f]{0,2}:/.test(value) || /^fe[89ab][0-9a-f]?:/.test(value);
    return false;
}

/** The person's list, kept to private addresses, without repeats. Pure. */
export function cleanLanHosts(hosts: readonly string[]): string[] {
    const kept = hosts.map((host) => host.trim().toLowerCase()).filter(isPrivateLanHost);
    return [...new Set(kept)].slice(0, protocol.LOCAL_MODEL_LIMITS.lanHosts);
}

/** Whether a turn may dial `host`: loopback, or an address the person added. */
export function hostAllowed(host: string, lanHosts: readonly string[]): boolean {
    return host === LOOPBACK || (isPrivateLanHost(host) && cleanLanHosts(lanHosts).includes(host.trim().toLowerCase()));
}

/** The base URL of one server on one host. Pure. */
export function serverUrl(server: protocol.LocalModelServer, host: string): string {
    const address = host === LOOPBACK ? "127.0.0.1" : isIP(host) === 6 ? `[${host}]` : host;
    return `http://${address}:${LOCAL_SERVER_PORTS[server].port}`;
}

/** The models a listing answered, or null when it is not that server's shape. Pure. */
export function readModelList(kind: "ollama" | "openai", body: unknown): { id: string; name?: string; }[] | null {
    const raw = kind === "ollama" ? (body as { models?: unknown; })?.models : (body as { data?: unknown; })?.data;
    if (!Array.isArray(raw)) return null;
    const models: { id: string; name?: string; }[] = [];
    for (const entry of raw) {
        const id = kind === "ollama" ? (entry as { model?: unknown; name?: unknown; })?.model ?? (entry as { name?: unknown; })?.name : (entry as { id?: unknown; })?.id;
        if (typeof id !== "string" || !id.trim() || id.length > 200) continue;
        models.push({ id });
        if (models.length >= protocol.LOCAL_MODEL_LIMITS.models) break;
    }
    return models;
}

/** Every server answering on loopback and the person's LAN addresses. A
 *  server that does not answer within a moment is simply not there. */
export async function detectLocalServers(lanHosts: readonly string[], fetcher: typeof fetch = fetch): Promise<LocalServer[]> {
    const hosts = [LOOPBACK, ...cleanLanHosts(lanHosts)];
    const probes = hosts.flatMap((host) =>
        protocol.LOCAL_MODEL_SERVERS.map(async (server): Promise<LocalServer | null> => {
            const { list } = LOCAL_SERVER_PORTS[server];
            try {
                const answer = await fetcher(`${serverUrl(server, host)}${list === "ollama" ? "/api/tags" : "/v1/models"}`, {
                    signal: AbortSignal.timeout(PROBE_MS),
                    redirect: "error"
                });
                if (!answer.ok) return null;
                const models = readModelList(list, await answer.json());
                return models ? { server, host, models } : null;
            } catch {
                return null;
            }
        })
    );
    const found = (await Promise.all(probes)).filter((entry): entry is LocalServer => entry !== null);
    return found.slice(0, protocol.LOCAL_MODEL_LIMITS.servers);
}

/** What one streamed `data:` line of an OpenAI-compatible answer adds. Pure. */
export function readStreamLine(line: string): {
    text?: string;
    reasoning?: string;
    calls?: ToolCallDelta[];
    finish?: "stop" | "length" | "tool-calls";
    usage?: { input: number; output: number; };
} | "done" | null {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return "done";
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        return null;
    }
    const choice = (parsed as { choices?: { delta?: Record<string, unknown>; finish_reason?: unknown; }[]; })?.choices?.[0];
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    const usage = (parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; }; })?.usage;
    const calls = readCallDeltas(delta.tool_calls);
    return {
        ...(typeof delta.content === "string" && delta.content ? { text: delta.content } : {}),
        ...(typeof reasoning === "string" && reasoning ? { reasoning } : {}),
        ...(calls.length > 0 ? { calls } : {}),
        ...(choice?.finish_reason === "length"
            ? { finish: "length" as const }
            : choice?.finish_reason === "tool_calls"
                ? { finish: "tool-calls" as const }
                : choice?.finish_reason
                    ? { finish: "stop" as const }
                    : {}),
        ...(usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number"
            ? { usage: { input: Math.max(0, Math.round(usage.prompt_tokens)), output: Math.max(0, Math.round(usage.completion_tokens)) } }
            : {})
    };
}

/** One piece of a tool call as a stream delta carries it: the first delta of
 *  a call has its id and name, later ones add to its arguments. */
export interface ToolCallDelta {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
}

function readCallDeltas(raw: unknown): ToolCallDelta[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, protocol.LOCAL_MODEL_LIMITS.tools).map((entry, at) => {
        const call = entry as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown; }; };
        const index = typeof call?.index === "number" && Number.isInteger(call.index) && call.index >= 0 ? call.index : at;
        return {
            index,
            ...(typeof call?.id === "string" && call.id ? { id: call.id } : {}),
            ...(typeof call?.function?.name === "string" && call.function.name ? { name: call.function.name } : {}),
            ...(typeof call?.function?.arguments === "string" ? { arguments: call.function.arguments } : {})
        };
    });
}

/** The calls a stream's deltas add up to, as `tool-call` events in order.
 *  Arguments that are not a JSON object become an empty input. Pure. */
export function collectToolCalls(deltas: readonly ToolCallDelta[], turnId: string): ChatEvent[] {
    const byIndex = new Map<number, { id?: string; name: string; args: string; }>();
    for (const delta of deltas) {
        const call = byIndex.get(delta.index) ?? { name: "", args: "" };
        if (delta.id) call.id = delta.id;
        // Some servers repeat the name on every delta; it is never split.
        if (delta.name && call.name !== delta.name) call.name += delta.name;
        if (delta.arguments) call.args += delta.arguments;
        byIndex.set(delta.index, call);
    }
    const events: ChatEvent[] = [];
    for (const [index, call] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
        if (!call.name || events.length >= protocol.LOCAL_MODEL_LIMITS.tools) continue;
        let input: Record<string, unknown> = {};
        try {
            const parsed: unknown = call.args.trim() ? JSON.parse(call.args) : {};
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
        } catch {
            input = {};
        }
        events.push({ kind: "tool-call", callId: (call.id ?? `${turnId}-${index}`).slice(0, 200), name: call.name.slice(0, 200), input });
    }
    return events;
}

/** A turn's conversation in the OpenAI-compatible shape: `local.conversation`
 *  with its tool calls when the server sent one, else the plain messages. Pure. */
export function chatMessages(turn: Pick<ChatTurn, "system" | "messages" | "local">): Record<string, unknown>[] {
    const system = turn.system ? [{ role: "system", content: turn.system }] : [];
    const conversation = turn.local?.conversation;
    if (!conversation) return [...system, ...turn.messages.map((message) => ({ role: message.role, content: message.text }))];
    return [
        ...system,
        ...conversation.map((message) => {
            if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.text };
            if (message.role === "user" || !message.calls?.length) return { role: message.role, content: message.text };
            return {
                role: "assistant",
                content: message.text || null,
                tool_calls: message.calls.map((call) => ({ id: call.callId, type: "function", function: { name: call.name, arguments: call.input } }))
            };
        })
    ];
}

/** Why a server refused a turn, from its status and body. A 400 that names
 *  tools is the server or the model not taking them. Pure. */
export function readRefusal(status: number, body: string): "tools" | "model-missing" | "rate-limited" | "failed" {
    if (status === 429) return "rate-limited";
    if (status === 400 && /\btools?\b|function.?call/i.test(body)) return "tools";
    if (status === 404 || /\bmodel\b.*\b(not found|not loaded|does not exist)\b|\bno models? (is )?loaded\b/i.test(body)) return "model-missing";
    return "failed";
}

export interface LocalChatDeps {
    readonly send: (frame: RunnerFrame) => boolean;
    readonly lanHosts: () => readonly string[];
    readonly fetch?: typeof fetch;
}

/** Polar Chat turns on a model server here, the same `chat.event` stream a
 *  Claude turn sends. With `local.tools` the model may ask for Polaris's
 *  tools; it never runs one, Polaris does and sends the next turn. */
export class LocalChat {
    readonly #turns = new Map<string, AbortController>();

    constructor(private readonly deps: LocalChatDeps) {}

    /** Takes a `chat.turn` that names a local model, and the cancel of one it
     *  holds; anything else is left to the Claude chat. */
    handle(frame: ServerFrame): boolean {
        if (frame.type === "chat.turn" && frame.local) {
            if (!this.#turns.has(frame.turnId)) void this.#run(frame, frame.local);
            return true;
        }
        if (frame.type === "chat.cancel" && this.#turns.has(frame.turnId)) {
            this.#turns.get(frame.turnId)!.abort();
            return true;
        }
        return false;
    }

    cancelAll(): void {
        for (const abort of this.#turns.values()) abort.abort();
    }

    async #run(turn: ChatTurn, local: NonNullable<ChatTurn["local"]>): Promise<void> {
        const abort = new AbortController();
        this.#turns.set(turn.turnId, abort);
        let seq = 0;
        const emit = (event: ChatEvent) => this.deps.send({ type: "chat.event", turnId: turn.turnId, seq: seq++, event });
        try {
            if (!hostAllowed(local.host, this.deps.lanHosts())) return void emit({ kind: "error", code: "not-installed" });
            const messages = chatMessages(turn);
            const tools = local.tools?.length
                ? local.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
                : null;
            const ask = (withTools: boolean) =>
                (this.deps.fetch ?? fetch)(`${serverUrl(local.server, local.host)}/v1/chat/completions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: local.model,
                        messages,
                        stream: true,
                        stream_options: { include_usage: true },
                        ...(withTools && tools ? { tools } : {})
                    }),
                    signal: abort.signal,
                    redirect: "error"
                });
            let answer: Response;
            try {
                answer = await ask(true);
                // A server or model without tool calls is asked again for text.
                if (tools && !answer.ok && readRefusal(answer.status, await answer.clone().text().catch(() => "")) === "tools") answer = await ask(false);
            } catch {
                return void emit(abort.signal.aborted ? { kind: "finish", reason: "cancelled" } : { kind: "error", code: "unreachable" });
            }
            if (!answer.ok || !answer.body) {
                const refusal = readRefusal(answer.status, await answer.text().catch(() => ""));
                return void emit({ kind: "error", code: refusal === "tools" ? "failed" : refusal });
            }
            let finish: "stop" | "length" | "tool-calls" = "stop";
            let usage: { input: number; output: number; } | undefined;
            const calls: ToolCallDelta[] = [];
            const decoder = new TextDecoder();
            let buffered = "";
            const reader = answer.body.getReader();
            for (let read = await reader.read(); !read.done; read = await reader.read()) {
                buffered += decoder.decode(read.value, { stream: true });
                const lines = buffered.split("\n");
                buffered = lines.pop() ?? "";
                for (const line of lines) {
                    const part = readStreamLine(line.trim());
                    if (!part || part === "done") continue;
                    if (part.text) emit({ kind: "text", text: part.text.slice(0, TEXT_MAX) });
                    if (part.reasoning) emit({ kind: "reasoning", text: part.reasoning.slice(0, TEXT_MAX) });
                    if (part.calls) calls.push(...part.calls);
                    if (part.finish) finish = part.finish;
                    if (part.usage) usage = part.usage;
                }
            }
            const asked = collectToolCalls(calls, turn.turnId);
            for (const event of asked) emit(event);
            if (asked.length > 0) finish = "tool-calls";
            else if (finish === "tool-calls") finish = "stop";
            emit({ kind: "finish", reason: finish, ...(usage ? { usage } : {}) });
        } catch {
            emit(abort.signal.aborted ? { kind: "finish", reason: "cancelled" } : { kind: "error", code: "failed" });
        } finally {
            this.#turns.delete(turn.turnId);
        }
    }
}
