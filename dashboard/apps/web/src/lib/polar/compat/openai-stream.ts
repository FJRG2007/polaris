/**
 * An AI SDK answer as OpenAI Chat Completions chunks (free-claude-code
 * `core/chat_completions/response.py`, `ChatOutput`):
 *
 *     {object: "chat.completion.chunk", choices: [{index: 0, delta: {role: "assistant"}, finish_reason: null}]}
 *     ... delta {content} | {reasoning_content} | {tool_calls: [{index, id, type, function: {name, arguments}}]}
 *     {choices: [{index: 0, delta: {}, finish_reason}]}
 *     {choices: [], usage}              only with stream_options.include_usage
 *     [DONE]
 *
 * With `include_usage`, every chunk before the last carries `usage: null`, as
 * OpenAI's do. Thinking goes out as `reasoning_content`, the field DeepSeek
 * introduced and the OpenAI-compatible clients read. The non-streamed answer
 * is the chunks folded together (`aggregateCompletion`).
 *
 * Pure.
 */

import { openaiErrorBody, type CompatError } from "@/lib/polar/compat/errors";
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from "ai";

export type Chunk = Record<string, unknown>;

export function chunkFrame(chunk: Chunk | "[DONE]"): string {
    return `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
}

/** The AI SDK's finish reason as OpenAI's. */
export function finishReasonOf(
    finish: FinishReason | undefined,
    toolUsed: boolean
): "stop" | "length" | "tool_calls" | "content_filter" {
    if (toolUsed || finish === "tool-calls") return "tool_calls";
    if (finish === "length") return "length";
    if (finish === "content-filter") return "content_filter";
    return "stop";
}

export function openaiUsage(
    usage: Partial<Pick<LanguageModelUsage, "inputTokens" | "outputTokens">> & {
        inputTokenDetails?: Partial<LanguageModelUsage["inputTokenDetails"]>;
        outputTokenDetails?: Partial<LanguageModelUsage["outputTokenDetails"]>;
    },
    estimatedInput: number
) {
    const prompt = usage.inputTokens ?? estimatedInput;
    const completion = usage.outputTokens ?? 0;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: usage.outputTokenDetails?.reasoningTokens ?? 0 }
    };
}

export interface ChatStreamOptions {
    model: string;
    inputTokens: number;
    includeUsage: boolean;
    id?: string;
    created?: number;
}

export class ChatStreamWriter {
    readonly id: string;
    private readonly created: number;
    private readonly tools = new Map<string, { index: number; streamed: boolean }>();
    private finished = false;

    constructor(private readonly options: ChatStreamOptions) {
        this.id = options.id ?? `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
        this.created = options.created ?? Math.floor(Date.now() / 1000);
    }

    private chunk(choices: unknown[], usage?: unknown): Chunk {
        const chunk: Chunk = {
            id: this.id,
            object: "chat.completion.chunk",
            created: this.created,
            model: this.options.model,
            choices
        };
        if (usage !== undefined) chunk.usage = usage;
        else if (this.options.includeUsage) chunk.usage = null;
        return chunk;
    }

    private delta(delta: Record<string, unknown>): Chunk {
        return this.chunk([{ index: 0, delta, finish_reason: null }]);
    }

    start(): Chunk[] {
        return [this.delta({ role: "assistant", content: "" })];
    }

    private toolDelta(id: string, name: string, args: string, streamed: boolean): Chunk {
        const index = this.tools.size;
        this.tools.set(id, { index, streamed });
        return this.delta({
            tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }]
        });
    }

    part(part: TextStreamPart<ToolSet>): Chunk[] {
        if (this.finished) return [];
        switch (part.type) {
            case "text-delta":
                return part.text ? [this.delta({ content: part.text })] : [];
            case "reasoning-delta":
                return part.text ? [this.delta({ reasoning_content: part.text })] : [];
            case "tool-input-start":
                return part.providerExecuted ? [] : [this.toolDelta(part.id, part.toolName, "", true)];
            case "tool-input-delta": {
                const state = this.tools.get(part.id);
                if (!state || !part.delta) return [];
                return [this.delta({ tool_calls: [{ index: state.index, function: { arguments: part.delta } }] })];
            }
            case "tool-call": {
                if (part.providerExecuted || this.tools.get(part.toolCallId)?.streamed) return [];
                return [this.toolDelta(part.toolCallId, part.toolName, JSON.stringify(part.input ?? {}), false)];
            }
            default:
                return [];
        }
    }

    finish(input: { finishReason: FinishReason | undefined; usage: Parameters<typeof openaiUsage>[0] }): (
        | Chunk
        | "[DONE]"
    )[] {
        if (this.finished) return [];
        this.finished = true;
        const out: (Chunk | "[DONE]")[] = [
            this.chunk([
                { index: 0, delta: {}, finish_reason: finishReasonOf(input.finishReason, this.tools.size > 0) }
            ])
        ];
        if (this.options.includeUsage) {
            out.push(this.chunk([], openaiUsage(input.usage, this.options.inputTokens)));
        }
        out.push("[DONE]");
        return out;
    }

    /** A failure mid-stream: OpenAI's error envelope as a data line, then done. */
    error(error: CompatError): (Chunk | "[DONE]")[] {
        if (this.finished) return [];
        this.finished = true;
        return [openaiErrorBody(error), "[DONE]"];
    }
}

/** Chunks folded into one `chat.completion`, or the error body they carried. */
export function aggregateCompletion(chunks: readonly (Chunk | "[DONE]")[], usage: unknown): Chunk {
    let head: Chunk | null = null;
    let text = "";
    let reasoning = "";
    let finish: unknown = null;
    const calls: { id: string; type: string; function: { name: string; arguments: string } }[] = [];
    for (const chunk of chunks) {
        if (chunk === "[DONE]") continue;
        if ("error" in chunk) return chunk;
        head ??= chunk;
        for (const choice of (chunk.choices as Record<string, unknown>[]) ?? []) {
            const delta = (choice.delta ?? {}) as Record<string, unknown>;
            if (typeof delta.content === "string") text += delta.content;
            if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
            for (const call of (delta.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
                const index = call.index as number;
                const fn = (call.function ?? {}) as { name?: string; arguments?: string };
                calls[index] ??= { id: call.id as string, type: "function", function: { name: fn.name ?? "", arguments: "" } };
                calls[index].function.arguments += fn.arguments ?? "";
            }
            if (choice.finish_reason) finish = choice.finish_reason;
        }
    }
    const message: Record<string, unknown> = { role: "assistant", content: text || (calls.length > 0 ? null : "") };
    if (reasoning) message.reasoning_content = reasoning;
    if (calls.length > 0) message.tool_calls = calls;
    return {
        id: head?.id,
        object: "chat.completion",
        created: head?.created,
        model: head?.model,
        choices: [{ index: 0, message, finish_reason: finish ?? "stop" }],
        usage
    };
}
