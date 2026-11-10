/**
 * An AI SDK answer as the OpenAI Responses event stream, in the order and
 * shape free-claude-code emits it (`core/openai_responses/messages_stream.py`,
 * `streaming/event_builders.py`, `streaming/completion.py`, `items.py`):
 *
 *     response.created                 {response: {status: "in_progress", output: []}}
 *     response.output_item.added       {output_index, item: reasoning | message | function_call, in_progress}
 *     response.reasoning_text.delta    {item_id, output_index, content_index: 0, delta}
 *     response.reasoning_text.done
 *     response.content_part.added      {part: {type: "output_text", text: "", annotations: []}}
 *     response.output_text.delta
 *     response.output_text.done
 *     response.content_part.done
 *     response.function_call_arguments.delta   the whole arguments, once, at the end
 *     response.function_call_arguments.done
 *     response.custom_tool_call_input.delta / .done   for a custom tool
 *     response.output_item.done        {item, completed}
 *     response.completed | response.incomplete {response: {..., output, usage}}
 *
 * Every event carries a `sequence_number` counting from 0. A failure once
 * the stream has begun is `response.failed`, with the response marked failed
 * and the error on it. The non-streamed answer is the terminal event's
 * response.
 *
 * Pure.
 */

import { CUSTOM_INPUT } from "@/lib/polar/compat/responses-request";
import type { SseEvent } from "@/lib/polar/compat/anthropic-stream";
import { openaiErrorBody, type CompatError } from "@/lib/polar/compat/errors";
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from "ai";

const hex = () => crypto.randomUUID().replaceAll("-", "");

export function responsesUsage(
    usage: Partial<Pick<LanguageModelUsage, "inputTokens" | "outputTokens">> & {
        inputTokenDetails?: Partial<LanguageModelUsage["inputTokenDetails"]>;
        outputTokenDetails?: Partial<LanguageModelUsage["outputTokenDetails"]>;
    },
    estimatedInput: number
) {
    const input = usage.inputTokens ?? estimatedInput;
    const output = usage.outputTokens ?? 0;
    return {
        input_tokens: input,
        input_tokens_details: { cached_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: Math.min(usage.outputTokenDetails?.reasoningTokens ?? 0, output) },
        total_tokens: input + output
    };
}

export interface ResponsesStreamOptions {
    model: string;
    inputTokens: number;
    /** Tools whose calls go back as `custom_tool_call`. */
    customTools: ReadonlySet<string>;
    /** Request fields the response echoes (free-claude-code `_payload`). */
    echo: {
        tools: unknown[];
        tool_choice: unknown;
        parallel_tool_calls: boolean;
        instructions?: string | null;
        max_output_tokens?: number | null;
        temperature?: number | null;
        top_p?: number | null;
        metadata?: unknown;
        reasoning?: unknown;
    };
    id?: string;
    createdAt?: number;
}

type Open =
    | { kind: "text"; id: string; itemId: string; slot: number; text: string }
    | { kind: "reasoning"; id: string; itemId: string; slot: number; text: string }
    | { kind: "tool"; id: string; itemId: string; slot: number; name: string; args: string; custom: boolean };

export class ResponsesStreamWriter {
    readonly id: string;
    private readonly createdAt: number;
    private sequence = 0;
    private readonly output: Record<string, unknown>[] = [];
    private open: Open | null = null;
    private readonly streamedTools = new Set<string>();
    private finished = false;

    constructor(private readonly options: ResponsesStreamOptions) {
        this.id = options.id ?? `resp_${hex()}`;
        this.createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
    }

    private event(type: string, data: Record<string, unknown>): SseEvent {
        return { event: type, data: { type, ...data, sequence_number: this.sequence++ } };
    }

    /** The response object at a status (free-claude-code `_payload`). */
    response(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
        const { echo } = this.options;
        const payload: Record<string, unknown> = {
            id: this.id,
            object: "response",
            created_at: this.createdAt,
            status,
            model: this.options.model,
            output: this.output.filter(Boolean),
            tools: echo.tools,
            tool_choice: echo.tool_choice ?? "auto",
            parallel_tool_calls: echo.parallel_tool_calls,
            usage: null,
            error: null,
            incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
            ...extra
        };
        for (const key of ["instructions", "max_output_tokens", "temperature", "top_p", "metadata", "reasoning"] as const) {
            if (echo[key] !== undefined && echo[key] !== null) payload[key] = echo[key];
        }
        return payload;
    }

    start(): SseEvent[] {
        return [this.event("response.created", { response: this.response("in_progress") })];
    }

    private textItem(open: { itemId: string }, text: string, status: string) {
        return {
            id: open.itemId,
            type: "message",
            status,
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }]
        };
    }

    private reasoningItem(open: { itemId: string }, text: string, status: string) {
        return { id: open.itemId, type: "reasoning", status, summary: [], content: [{ type: "reasoning_text", text }] };
    }

    private toolItem(open: Extract<Open, { kind: "tool" }>, status: string) {
        return open.custom
            ? { id: open.itemId, type: "custom_tool_call", status, call_id: open.id, name: open.name, input: customInput(open.args) }
            : { id: open.itemId, type: "function_call", status, call_id: open.id, name: open.name, arguments: open.args };
    }

    private close(): SseEvent[] {
        const open = this.open;
        if (!open) return [];
        this.open = null;
        const at = { item_id: open.itemId, output_index: open.slot };
        if (open.kind === "text") {
            const item = this.textItem(open, open.text, "completed");
            this.output[open.slot] = item;
            return [
                this.event("response.output_text.done", { ...at, content_index: 0, text: open.text }),
                this.event("response.content_part.done", {
                    ...at,
                    content_index: 0,
                    part: { type: "output_text", text: open.text, annotations: [] }
                }),
                this.event("response.output_item.done", { output_index: open.slot, item })
            ];
        }
        if (open.kind === "reasoning") {
            const item = this.reasoningItem(open, open.text, "completed");
            this.output[open.slot] = item;
            const events: SseEvent[] = [];
            if (open.text) events.push(this.event("response.reasoning_text.done", { ...at, content_index: 0, text: open.text }));
            events.push(this.event("response.output_item.done", { output_index: open.slot, item }));
            return events;
        }
        const item = this.toolItem(open, "completed");
        this.output[open.slot] = item;
        const events: SseEvent[] = [];
        if (open.custom) {
            const input = customInput(open.args);
            if (input) events.push(this.event("response.custom_tool_call_input.delta", { ...at, delta: input }));
            events.push(this.event("response.custom_tool_call_input.done", { ...at, input }));
        } else {
            if (open.args) events.push(this.event("response.function_call_arguments.delta", { ...at, delta: open.args }));
            events.push(this.event("response.function_call_arguments.done", { ...at, arguments: open.args }));
        }
        events.push(this.event("response.output_item.done", { output_index: open.slot, item }));
        return events;
    }

    private begin(kind: "text" | "reasoning", id: string): SseEvent[] {
        if (this.open?.kind === kind && this.open.id === id) return [];
        const events = this.close();
        const slot = this.output.length;
        this.output.push(undefined as never);
        if (kind === "text") {
            const open = { kind, id, itemId: `msg_${hex()}`, slot, text: "" } as const;
            this.open = { ...open };
            events.push(
                this.event("response.output_item.added", { output_index: slot, item: this.textItem(open, "", "in_progress") }),
                this.event("response.content_part.added", {
                    item_id: open.itemId,
                    output_index: slot,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] }
                })
            );
        } else {
            const open = { kind, id, itemId: `rs_${hex()}`, slot, text: "" } as const;
            this.open = { ...open };
            events.push(
                this.event("response.output_item.added", {
                    output_index: slot,
                    item: this.reasoningItem(open, "", "in_progress")
                })
            );
        }
        return events;
    }

    private beginTool(id: string, name: string): SseEvent[] {
        const events = this.close();
        const slot = this.output.length;
        this.output.push(undefined as never);
        const custom = this.options.customTools.has(name);
        const open: Extract<Open, { kind: "tool" }> = {
            kind: "tool",
            id,
            itemId: `${custom ? "ctc_" : "fc_"}${hex()}`,
            slot,
            name,
            args: "",
            custom
        };
        this.open = open;
        events.push(this.event("response.output_item.added", { output_index: slot, item: this.toolItem(open, "in_progress") }));
        return events;
    }

    part(part: TextStreamPart<ToolSet>): SseEvent[] {
        if (this.finished) return [];
        switch (part.type) {
            case "text-delta": {
                if (!part.text) return [];
                const events = this.begin("text", part.id);
                const open = this.open as Extract<Open, { kind: "text" }>;
                open.text += part.text;
                events.push(
                    this.event("response.output_text.delta", {
                        item_id: open.itemId,
                        output_index: open.slot,
                        content_index: 0,
                        delta: part.text
                    })
                );
                return events;
            }
            case "text-end":
                return this.open?.kind === "text" && this.open.id === part.id ? this.close() : [];
            case "reasoning-delta": {
                if (!part.text) return [];
                const events = this.begin("reasoning", part.id);
                const open = this.open as Extract<Open, { kind: "reasoning" }>;
                open.text += part.text;
                events.push(
                    this.event("response.reasoning_text.delta", {
                        item_id: open.itemId,
                        output_index: open.slot,
                        content_index: 0,
                        delta: part.text
                    })
                );
                return events;
            }
            case "reasoning-end":
                return this.open?.kind === "reasoning" && this.open.id === part.id ? this.close() : [];
            case "tool-input-start":
                if (part.providerExecuted) return [];
                this.streamedTools.add(part.id);
                return this.beginTool(part.id, part.toolName);
            case "tool-input-delta":
                if (this.open?.kind === "tool" && this.open.id === part.id) this.open.args += part.delta;
                return [];
            case "tool-input-end":
                return [];
            case "tool-call": {
                if (part.providerExecuted) return [];
                const args = JSON.stringify(part.input ?? {});
                if (this.streamedTools.has(part.toolCallId)) {
                    if (this.open?.kind !== "tool" || this.open.id !== part.toolCallId) return [];
                    // The parsed input is the one the provider settled on.
                    this.open.args = args;
                    return this.close();
                }
                const events = this.beginTool(part.toolCallId, part.toolName);
                (this.open as Extract<Open, { kind: "tool" }>).args = args;
                return [...events, ...this.close()];
            }
            default:
                return [];
        }
    }

    finish(input: { finishReason: FinishReason | undefined; usage: Parameters<typeof responsesUsage>[0] }): SseEvent[] {
        if (this.finished) return [];
        this.finished = true;
        const events = this.close();
        const usage = responsesUsage(input.usage, this.options.inputTokens);
        const incomplete = input.finishReason === "length";
        const type = incomplete ? "response.incomplete" : "response.completed";
        events.push(this.event(type, { response: this.response(incomplete ? "incomplete" : "completed", { usage }) }));
        return events;
    }

    error(error: CompatError): SseEvent[] {
        if (this.finished) return [];
        this.finished = true;
        return [
            this.event("response.failed", {
                response: this.response("failed", { error: openaiErrorBody(error).error })
            })
        ];
    }
}

/** A custom tool's raw input from the arguments the model wrote. */
function customInput(args: string): string {
    if (!args) return "";
    try {
        const parsed = JSON.parse(args) as unknown;
        if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[CUSTOM_INPUT] === "string") {
            return (parsed as Record<string, string>)[CUSTOM_INPUT]!;
        }
        return typeof parsed === "string" ? parsed : args;
    } catch {
        return args;
    }
}

/** The response a non-streamed request answers with: the terminal event's. */
export function aggregateResponse(events: readonly SseEvent[]): Record<string, unknown> {
    const terminal = [...events].reverse().find((event) =>
        ["response.completed", "response.incomplete", "response.failed"].includes(event.event)
    );
    return (terminal?.data.response as Record<string, unknown> | undefined) ?? {};
}
