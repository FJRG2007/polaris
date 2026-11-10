/**
 * The Anthropic Messages request (platform.claude.com/docs/en/api/messages),
 * read and turned into AI SDK messages, tools and call options. Mirrors
 * free-claude-code's `core/anthropic/models.py` (what is accepted) and
 * `conversion.py` (what each block becomes):
 *
 * - `system` as a string or text blocks; `cache_control` on a block carries
 *   to Anthropic as the AI SDK's `cacheControl`.
 * - text, image (base64 and url), document (base64, url, plain text),
 *   tool_use, tool_result (string or blocks, `is_error`), thinking and
 *   redacted_thinking. A thinking block keeps its signature, and a redacted one
 *   its data, as the Anthropic provider's `providerOptions`, so a turn routed
 *   to Anthropic replays them; other providers ignore them.
 * - tools are declared without `execute`: the client runs them and sends the
 *   result back on its next request.
 *
 * Unknown fields are kept and ignored: Claude Code sends betas this proxy has
 * no use for, and refusing them would refuse Claude Code.
 *
 * Pure.
 */

import { z } from "zod";
import type { SdkReasoning } from "@/lib/polar/routing";
import { jsonSchema, tool, type ModelMessage, type ToolResultPart, type ToolSet } from "ai";

const cacheControl = z.object({ type: z.string() }).passthrough().optional();

const textBlock = z
    .object({ type: z.literal("text"), text: z.string(), cache_control: cacheControl })
    .passthrough();

const base64Source = z
    .object({ type: z.literal("base64"), media_type: z.string().min(1).max(100), data: z.string() })
    .passthrough();
const urlSource = z.object({ type: z.literal("url"), url: z.string().url() }).passthrough();

const imageBlock = z
    .object({
        type: z.literal("image"),
        source: z.discriminatedUnion("type", [base64Source, urlSource]),
        cache_control: cacheControl
    })
    .passthrough();

const documentBlock = z
    .object({
        type: z.literal("document"),
        source: z.discriminatedUnion("type", [
            base64Source,
            urlSource,
            z
                .object({ type: z.literal("text"), media_type: z.string().optional(), data: z.string() })
                .passthrough()
        ]),
        title: z.string().nullish(),
        cache_control: cacheControl
    })
    .passthrough();

const toolUseBlock = z
    .object({
        type: z.literal("tool_use"),
        id: z.string().min(1),
        name: z.string().min(1),
        input: z.unknown(),
        cache_control: cacheControl
    })
    .passthrough();

/** Any other block (server tool results, citations, search results): kept as
 *  its JSON in a text part rather than refused, so a conversation that once
 *  held one can go on. */
const otherBlock = z.object({ type: z.string() }).passthrough();

const toolResultBlock = z
    .object({
        type: z.literal("tool_result"),
        tool_use_id: z.string().min(1),
        content: z.union([z.string(), z.array(z.union([textBlock, imageBlock, otherBlock]))]).optional(),
        is_error: z.boolean().optional(),
        cache_control: cacheControl
    })
    .passthrough();

const thinkingBlock = z
    .object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().optional() })
    .passthrough();

const redactedThinkingBlock = z
    .object({ type: z.literal("redacted_thinking"), data: z.string() })
    .passthrough();

const contentBlock = z.union([
    textBlock,
    imageBlock,
    documentBlock,
    toolUseBlock,
    toolResultBlock,
    thinkingBlock,
    redactedThinkingBlock,
    otherBlock
]);
export type AnthropicBlock = z.infer<typeof contentBlock>;
type TextBlock = z.infer<typeof textBlock>;
type ImageBlock = z.infer<typeof imageBlock>;
type DocumentBlock = z.infer<typeof documentBlock>;
type ToolUseBlock = z.infer<typeof toolUseBlock>;
type ToolResultBlock = z.infer<typeof toolResultBlock>;
type ThinkingBlock = z.infer<typeof thinkingBlock>;
type RedactedThinkingBlock = z.infer<typeof redactedThinkingBlock>;

const message = z
    .object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(contentBlock)])
    })
    .passthrough();
export type AnthropicMessage = z.infer<typeof message>;

const toolDefinition = z
    .object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        input_schema: z.record(z.unknown()).optional(),
        type: z.string().optional(),
        cache_control: cacheControl
    })
    .passthrough();
export type AnthropicTool = z.infer<typeof toolDefinition>;

const toolChoice = z.discriminatedUnion("type", [
    z.object({ type: z.literal("auto") }).passthrough(),
    z.object({ type: z.literal("any") }).passthrough(),
    z.object({ type: z.literal("none") }).passthrough(),
    z.object({ type: z.literal("tool"), name: z.string().min(1) }).passthrough()
]);

const thinking = z
    .object({
        type: z.enum(["enabled", "adaptive", "disabled"]).optional(),
        budget_tokens: z.number().int().positive().optional()
    })
    .passthrough();

/** Most messages one request may carry; well past any context window. */
const MESSAGES_MOST = 10_000;

export const messagesRequestSchema = z
    .object({
        model: z.string().trim().min(1).max(300),
        max_tokens: z.number().int().positive().optional(),
        messages: z.array(message).max(MESSAGES_MOST),
        system: z.union([z.string(), z.array(textBlock)]).optional(),
        tools: z.array(toolDefinition).max(1000).optional(),
        tool_choice: toolChoice.optional(),
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        top_k: z.number().int().positive().optional(),
        stop_sequences: z.array(z.string()).max(64).optional(),
        stream: z.boolean().optional(),
        metadata: z.object({ user_id: z.string().nullish() }).passthrough().optional(),
        thinking: thinking.optional(),
        output_config: z.object({ effort: z.string().optional() }).passthrough().optional()
    })
    .passthrough();
export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

type ProviderOptions = Record<string, Record<string, never>>;

/** The Anthropic `cacheControl` a block asked for, as AI SDK options. */
function cacheOptions(block: object): { providerOptions?: ProviderOptions } {
    const control = (block as { cache_control?: unknown }).cache_control as Record<string, never> | undefined;
    return control ? { providerOptions: { anthropic: { cacheControl: control } as never } } : {};
}

/** The system prompt as system messages, one per block so each keeps its
 *  cache breakpoint. */
export function systemMessages(system: MessagesRequest["system"]): ModelMessage[] {
    if (system === undefined) return [];
    if (typeof system === "string") return system ? [{ role: "system", content: system }] : [];
    return system
        .filter((block) => block.text)
        .map((block): ModelMessage => ({ role: "system", content: block.text, ...cacheOptions(block) }));
}

type UserPart = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number];
type AssistantPart = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number];

function imagePart(block: ImageBlock): UserPart {
    const source = block.source;
    return source.type === "base64"
        ? { type: "image", image: source.data, mediaType: source.media_type, ...cacheOptions(block) }
        : { type: "image", image: new URL(source.url), ...cacheOptions(block) };
}

function documentPart(block: DocumentBlock): UserPart {
    const source = block.source;
    const filename = block.title ?? undefined;
    if (source.type === "text") return { type: "text", text: source.data, ...cacheOptions(block) };
    if (source.type === "url") {
        return {
            type: "file",
            data: new URL(source.url),
            mediaType: "application/pdf",
            filename,
            ...cacheOptions(block)
        };
    }
    return { type: "file", data: source.data, mediaType: source.media_type, filename, ...cacheOptions(block) };
}

const blockText = (part: { type: string }) =>
    part.type === "text" ? (part as TextBlock).text : JSON.stringify(part);

/** A tool result's output: text stays text; images ride along as files; an
 *  error is error text, which every provider can carry. */
export function toolOutput(block: Pick<ToolResultBlock, "content" | "is_error">): ToolResultPart["output"] {
    const content = block.content ?? "";
    if (typeof content === "string") {
        return block.is_error ? { type: "error-text", value: content } : { type: "text", value: content };
    }
    const hasImage = content.some((part) => part.type === "image");
    if (block.is_error || !hasImage) {
        const text = content.map(blockText).join("\n");
        return block.is_error ? { type: "error-text", value: text } : { type: "text", value: text };
    }
    return {
        type: "content",
        value: content.map((part) => {
            if (part.type !== "image") return { type: "text" as const, text: blockText(part) };
            const source = (part as ImageBlock).source;
            return source.type === "base64"
                ? {
                      type: "file" as const,
                      data: { type: "data" as const, data: source.data },
                      mediaType: source.media_type
                  }
                : {
                      type: "file" as const,
                      data: { type: "url" as const, url: new URL(source.url) },
                      mediaType: "image"
                  };
        })
    };
}

function assistantParts(blocks: readonly AnthropicBlock[], names: Map<string, string>): AssistantPart[] {
    const parts: AssistantPart[] = [];
    for (const block of blocks) {
        switch (block.type) {
            case "text": {
                const text = (block as TextBlock).text;
                if (text) parts.push({ type: "text", text, ...cacheOptions(block) });
                break;
            }
            case "thinking": {
                const think = block as ThinkingBlock;
                parts.push({
                    type: "reasoning",
                    text: think.thinking,
                    ...(think.signature
                        ? { providerOptions: { anthropic: { signature: think.signature } } }
                        : {})
                });
                break;
            }
            case "redacted_thinking":
                parts.push({
                    type: "reasoning",
                    text: "",
                    providerOptions: { anthropic: { redactedData: (block as RedactedThinkingBlock).data } }
                });
                break;
            case "tool_use": {
                const call = block as ToolUseBlock;
                names.set(call.id, call.name);
                parts.push({
                    type: "tool-call",
                    toolCallId: call.id,
                    toolName: call.name,
                    input: call.input ?? {},
                    ...cacheOptions(call)
                });
                break;
            }
            default:
                parts.push({ type: "text", text: JSON.stringify(block) });
        }
    }
    return parts;
}

/**
 * The conversation as AI SDK messages. A user turn's tool results become one
 * `tool` message ahead of whatever else the turn says, the order the AI SDK
 * and every provider expect. A tool result names its call only by id, so the
 * tool's name is looked up from the assistant turn that made the call.
 */
export function toModelMessages(messages: readonly AnthropicMessage[]): ModelMessage[] {
    const names = new Map<string, string>();
    const out: ModelMessage[] = [];
    for (const entry of messages) {
        if (typeof entry.content === "string") {
            out.push({ role: entry.role, content: entry.content });
            continue;
        }
        const blocks = entry.content as AnthropicBlock[];
        if (entry.role === "assistant") {
            const parts = assistantParts(blocks, names);
            if (parts.length > 0) out.push({ role: "assistant", content: parts });
            continue;
        }
        const results: ToolResultPart[] = [];
        const parts: UserPart[] = [];
        for (const block of blocks) {
            switch (block.type) {
                case "tool_result": {
                    const result = block as ToolResultBlock;
                    results.push({
                        type: "tool-result",
                        toolCallId: result.tool_use_id,
                        toolName: names.get(result.tool_use_id) ?? "unknown",
                        output: toolOutput(result),
                        ...cacheOptions(result)
                    });
                    break;
                }
                case "text": {
                    const text = (block as TextBlock).text;
                    if (text) parts.push({ type: "text", text, ...cacheOptions(block) });
                    break;
                }
                case "image":
                    parts.push(imagePart(block as ImageBlock));
                    break;
                case "document":
                    parts.push(documentPart(block as DocumentBlock));
                    break;
                case "thinking":
                case "redacted_thinking":
                    // A user turn cannot think; nothing to send.
                    break;
                default:
                    parts.push({ type: "text", text: JSON.stringify(block) });
            }
        }
        if (results.length > 0) out.push({ role: "tool", content: results });
        if (parts.length > 0) out.push({ role: "user", content: parts });
    }
    return out;
}

/** The client's tools, declared for the model without `execute`. */
export function toolsOf(tools: MessagesRequest["tools"]): ToolSet | undefined {
    if (!tools || tools.length === 0) return undefined;
    const set: ToolSet = {};
    for (const definition of tools) {
        set[definition.name] = tool({
            description: definition.description,
            inputSchema: jsonSchema((definition.input_schema ?? { type: "object", properties: {} }) as never),
            ...cacheOptions(definition)
        });
    }
    return set;
}

export type SdkToolChoice = "auto" | "none" | "required" | { type: "tool"; toolName: string };

/** `tool_choice` as the AI SDK's: `any` is `required`. */
export function toolChoiceOf(choice: MessagesRequest["tool_choice"]): SdkToolChoice | undefined {
    if (!choice) return undefined;
    switch (choice.type) {
        case "any":
            return "required";
        case "tool":
            return { type: "tool", toolName: (choice as { name: string }).name };
        default:
            return choice.type;
    }
}

/** A named effort as the AI SDK's level; `minimal` has no AI SDK level of its own. */
export const EFFORTS: Readonly<Record<string, SdkReasoning>> = {
    none: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max"
};

/**
 * The effort a thinking budget stands for. free-claude-code's own table
 * (`core/reasoning.py`) tops out at 8k tokens, below what Claude Code sends
 * for "think hard" (10k) or "ultrathink" (32k), so it would read every budget
 * as the maximum. These steps follow Claude Code's levels instead.
 */
export function effortForBudget(budget: number): SdkReasoning {
    if (budget <= 2_048) return "low";
    if (budget <= 8_192) return "medium";
    if (budget <= 24_576) return "high";
    return "xhigh";
}

/**
 * What the client asked to think at, free-claude-code's
 * `client_reasoning_policy`: `output_config.effort` "none" or
 * `thinking.type` "disabled" is off; an effort names its level; a budget maps
 * to one; enabled or adaptive with neither is the provider's default
 * (undefined), as is a request that says nothing.
 */
export function clientReasoning(
    request: Pick<MessagesRequest, "thinking" | "output_config">
): SdkReasoning | undefined {
    const raw = request.output_config?.effort?.trim().toLowerCase();
    const effort = raw ? EFFORTS[raw] : undefined;
    if (effort === "none" || request.thinking?.type === "disabled") return "none";
    if (effort) return effort;
    const budget = request.thinking?.budget_tokens;
    return budget !== undefined ? effortForBudget(budget) : undefined;
}
