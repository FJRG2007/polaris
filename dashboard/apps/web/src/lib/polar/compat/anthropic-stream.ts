/**
 * An AI SDK answer as the Anthropic Messages stream, event by event
 * (platform.claude.com/docs/en/build-with-claude/streaming; free-claude-code
 * `core/anthropic/streaming/ledger.py` and `emitter.py`):
 *
 *     message_start          {message: {id, type, role, content: [], model,
 *                             stop_reason: null, stop_sequence: null,
 *                             usage: {input_tokens, output_tokens: 1}}}
 *     ping
 *     content_block_start    {index, content_block: {type: "thinking", thinking: ""}}
 *     content_block_delta    {index, delta: {type: "thinking_delta", thinking}}
 *     content_block_delta    {index, delta: {type: "signature_delta", signature}}
 *     content_block_stop     {index}
 *     content_block_start    {index, content_block: {type: "text", text: ""}}
 *     content_block_delta    {index, delta: {type: "text_delta", text}}
 *     content_block_stop
 *     content_block_start    {index, content_block: {type: "tool_use", id, name, input: {}}}
 *     content_block_delta    {index, delta: {type: "input_json_delta", partial_json}}
 *     content_block_stop
 *     message_delta          {delta: {stop_reason, stop_sequence}, usage}
 *     message_stop
 *
 * One block is open at a time, as Anthropic streams them; a block that starts
 * closes the one before it. A failure after the stream began is an `error`
 * event and nothing follows it.
 *
 * The non-streamed answer is the same events folded into one message
 * (`aggregateMessage`), which is how free-claude-code builds it too
 * (`sse_aggregation.py`): both shapes come from one code path.
 *
 * Pure.
 */

import { anthropicErrorBody, type CompatError } from "@/lib/polar/compat/errors";
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from "ai";

export interface SseEvent {
    event: string;
    data: Record<string, unknown>;
}

/** One event as the wire carries it. */
export function sseFrame(event: SseEvent): string {
    return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** The SSE response headers free-claude-code sends (`emitter.py`). */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
};

/** A message id in Anthropic's shape. */
export function messageId(): string {
    return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The AI SDK's finish reason as Anthropic's, free-claude-code's
 * `STOP_REASON_MAP`: a length stop is `max_tokens`, a tool call `tool_use`,
 * and a stop the provider says was a stop sequence `stop_sequence`. Anything
 * else ends the turn. A turn that called a tool is `tool_use` whatever the
 * provider said, or the client would not run the tool.
 */
export function stopReason(
    finish: FinishReason | undefined,
    { raw, toolUsed }: { raw?: string; toolUsed?: boolean } = {}
): "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" {
    if (toolUsed || finish === "tool-calls") return "tool_use";
    if (finish === "length") return "max_tokens";
    if (raw === "stop_sequence") return "stop_sequence";
    return "end_turn";
}

/**
 * Usage in Anthropic's fields. The AI SDK's input count includes cached
 * tokens; Anthropic's `input_tokens` does not, so a reported cache read or
 * write is taken out of it (free-claude-code `core/anthropic/usage.py`).
 */
export function anthropicUsage(
    usage: Partial<Pick<LanguageModelUsage, "inputTokens" | "outputTokens">> & {
        inputTokenDetails?: Partial<LanguageModelUsage["inputTokenDetails"]>;
    },
    estimatedInput: number
): Record<string, number> {
    const total = usage.inputTokens ?? estimatedInput;
    const out: Record<string, number> = { input_tokens: total, output_tokens: usage.outputTokens ?? 0 };
    let remaining = total;
    const read = usage.inputTokenDetails?.cacheReadTokens;
    if (typeof read === "number" && read >= 0 && read <= remaining) {
        out.cache_read_input_tokens = read;
        remaining -= read;
    }
    const write = usage.inputTokenDetails?.cacheWriteTokens;
    if (typeof write === "number" && write >= 0 && write <= remaining) {
        out.cache_creation_input_tokens = write;
        remaining -= write;
    }
    out.input_tokens = remaining;
    return out;
}

type Part = TextStreamPart<ToolSet>;

type Open =
    | { kind: "text"; id: string; index: number }
    | { kind: "thinking"; id: string; index: number }
    | { kind: "redacted"; id: string; index: number }
    | { kind: "tool"; id: string; index: number };

const anthropicMeta = (part: { providerMetadata?: unknown }) =>
    ((part.providerMetadata as Record<string, Record<string, unknown> | undefined> | undefined)?.anthropic ??
        {}) as Record<string, unknown>;

export interface AnthropicStreamOptions {
    /** The model id the client asked for: the answer names it back. */
    model: string;
    /** The prompt's estimated size, for `message_start` before usage is known. */
    inputTokens: number;
    /** Whether thinking blocks reach the client; off when it turned thinking off. */
    thinking: boolean;
    id?: string;
}

/** Turns AI SDK stream parts into Anthropic events. */
export class AnthropicStreamWriter {
    private next = 0;
    private open: Open | null = null;
    private readonly tools = new Map<string, { index: number; streamed: boolean; closed: boolean }>();
    private toolUsed = false;
    private stopSequence: string | null = null;
    private finished = false;
    readonly id: string;

    constructor(private readonly options: AnthropicStreamOptions) {
        this.id = options.id ?? messageId();
    }

    /** `message_start` and the `ping` Anthropic sends right after it. */
    start(): SseEvent[] {
        return [
            {
                event: "message_start",
                data: {
                    type: "message_start",
                    message: {
                        id: this.id,
                        type: "message",
                        role: "assistant",
                        content: [],
                        model: this.options.model,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: this.options.inputTokens, output_tokens: 1 }
                    }
                }
            },
            { event: "ping", data: { type: "ping" } }
        ];
    }

    private close(): SseEvent[] {
        if (!this.open) return [];
        const index = this.open.index;
        if (this.open.kind === "tool") {
            const state = this.tools.get(this.open.id);
            if (state) state.closed = true;
        }
        this.open = null;
        return [{ event: "content_block_stop", data: { type: "content_block_stop", index } }];
    }

    private begin(open: Omit<Open, "index">, block: Record<string, unknown>): SseEvent[] {
        const events = this.close();
        const index = this.next++;
        this.open = { ...open, index } as Open;
        events.push({
            event: "content_block_start",
            data: { type: "content_block_start", index, content_block: block }
        });
        return events;
    }

    private delta(delta: Record<string, unknown>): SseEvent {
        return {
            event: "content_block_delta",
            data: { type: "content_block_delta", index: this.open!.index, delta }
        };
    }

    /** The open block of this kind and id, opening one when there is none. */
    private ensure(kind: "text" | "thinking", id: string): SseEvent[] {
        if (this.open?.kind === kind && this.open.id === id) return [];
        return kind === "text"
            ? this.begin({ kind, id }, { type: "text", text: "" })
            : this.begin({ kind, id }, { type: "thinking", thinking: "" });
    }

    private signature(part: { providerMetadata?: unknown }): SseEvent[] {
        const signature = anthropicMeta(part).signature;
        if (typeof signature !== "string" || !signature || this.open?.kind !== "thinking") return [];
        return [this.delta({ type: "signature_delta", signature })];
    }

    private toolStart(id: string, name: string, streamed: boolean): SseEvent[] {
        this.toolUsed = true;
        this.tools.set(id, { index: this.next, streamed, closed: false });
        return this.begin({ kind: "tool", id }, { type: "tool_use", id, name, input: {} });
    }

    part(part: Part): SseEvent[] {
        if (this.finished) return [];
        switch (part.type) {
            case "text-start":
                return [];
            case "text-delta":
                if (!part.text) return [];
                return [...this.ensure("text", part.id), this.delta({ type: "text_delta", text: part.text })];
            case "text-end":
                return this.open?.kind === "text" && this.open.id === part.id ? this.close() : [];
            case "reasoning-start": {
                if (!this.options.thinking) return [];
                const redacted = anthropicMeta(part).redactedData;
                if (typeof redacted === "string") {
                    return this.begin({ kind: "redacted", id: part.id }, { type: "redacted_thinking", data: redacted });
                }
                return [];
            }
            case "reasoning-delta": {
                if (!this.options.thinking) return [];
                if (this.open?.kind === "redacted" && this.open.id === part.id) return [];
                const events: SseEvent[] = [];
                if (part.text) {
                    events.push(
                        ...this.ensure("thinking", part.id),
                        this.delta({ type: "thinking_delta", thinking: part.text })
                    );
                }
                return [...events, ...this.signature(part)];
            }
            case "reasoning-end": {
                if (!this.options.thinking) return [];
                if (this.open?.id !== part.id || (this.open.kind !== "thinking" && this.open.kind !== "redacted")) {
                    return [];
                }
                return [...this.signature(part), ...this.close()];
            }
            case "tool-input-start":
                if (part.providerExecuted) return [];
                return this.toolStart(part.id, part.toolName, true);
            case "tool-input-delta": {
                if (this.open?.kind !== "tool" || this.open.id !== part.id || !part.delta) return [];
                return [this.delta({ type: "input_json_delta", partial_json: part.delta })];
            }
            case "tool-input-end":
                return this.open?.kind === "tool" && this.open.id === part.id ? this.close() : [];
            case "tool-call": {
                if (part.providerExecuted) return [];
                const known = this.tools.get(part.toolCallId);
                if (known?.streamed) return this.open?.id === part.toolCallId ? this.close() : [];
                // Not streamed as it was written: the whole input in one delta.
                const json = JSON.stringify(part.input ?? {});
                return [
                    ...this.toolStart(part.toolCallId, part.toolName, false),
                    this.delta({ type: "input_json_delta", partial_json: json }),
                    ...this.close()
                ];
            }
            case "finish-step": {
                const sequence = anthropicMeta(part).stopSequence;
                if (typeof sequence === "string") this.stopSequence = sequence;
                return [];
            }
            default:
                return [];
        }
    }

    /** Closes the open block and ends the message with its stop reason and usage. */
    finish(input: {
        finishReason: FinishReason | undefined;
        rawFinishReason?: string;
        usage: Parameters<typeof anthropicUsage>[0];
    }): SseEvent[] {
        if (this.finished) return [];
        this.finished = true;
        const reason = stopReason(input.finishReason, { raw: input.rawFinishReason, toolUsed: this.toolUsed });
        return [
            ...this.close(),
            {
                event: "message_delta",
                data: {
                    type: "message_delta",
                    delta: {
                        stop_reason: reason,
                        stop_sequence: reason === "stop_sequence" ? this.stopSequence : null
                    },
                    usage: anthropicUsage(input.usage, this.options.inputTokens)
                }
            },
            { event: "message_stop", data: { type: "message_stop" } }
        ];
    }

    /** A failure once the stream has begun: an `error` event, and nothing after. */
    error(error: CompatError): SseEvent[] {
        if (this.finished) return [];
        this.finished = true;
        return [{ event: "error", data: anthropicErrorBody(error) }];
    }
}

/**
 * Events folded into the message a non-streamed request answers with. Tool
 * inputs arrive as JSON fragments and are parsed once their block closes; an
 * input that does not parse is kept as an empty object rather than failing
 * the answer. Returns the error body instead when the events carried one.
 */
export function aggregateMessage(events: readonly SseEvent[]): Record<string, unknown> {
    let message: Record<string, unknown> = {};
    const content: Record<string, unknown>[] = [];
    const json = new Map<number, string>();
    for (const { event, data } of events) {
        switch (event) {
            case "message_start":
                message = { ...(data.message as Record<string, unknown>) };
                break;
            case "content_block_start":
                content[data.index as number] = { ...(data.content_block as Record<string, unknown>) };
                break;
            case "content_block_delta": {
                const index = data.index as number;
                const block = content[index]!;
                const delta = data.delta as Record<string, string>;
                if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
                else if (delta.type === "thinking_delta") block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
                else if (delta.type === "signature_delta") block.signature = delta.signature;
                else if (delta.type === "input_json_delta") json.set(index, `${json.get(index) ?? ""}${delta.partial_json}`);
                break;
            }
            case "content_block_stop": {
                const index = data.index as number;
                const block = content[index]!;
                if (block.type === "tool_use") {
                    const text = json.get(index) ?? "";
                    try {
                        block.input = text ? JSON.parse(text) : {};
                    } catch {
                        block.input = {};
                    }
                }
                if (block.type === "thinking" && block.signature === undefined) block.signature = "";
                break;
            }
            case "message_delta": {
                const delta = data.delta as Record<string, unknown>;
                message.stop_reason = delta.stop_reason;
                message.stop_sequence = delta.stop_sequence ?? null;
                message.usage = data.usage;
                break;
            }
            case "error":
                return data;
        }
    }
    return { ...message, content: content.filter(Boolean) };
}
