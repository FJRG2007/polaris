/**
 * The OpenAI Chat Completions request (platform.openai.com/docs/api-reference/chat),
 * read and turned into AI SDK messages, tools and options, for the clients
 * that speak it: Codex, OpenCode, Cline, Aider and anything that takes an
 * OpenAI base URL. Mirrors what free-claude-code's `core/chat_completions/request.py`
 * accepts: system and developer turns, text and `image_url` parts, assistant
 * `tool_calls` and `reasoning_content`, `tool` results, `tools`,
 * `tool_choice`, `stop`, `max_tokens`/`max_completion_tokens` and
 * `reasoning_effort`.
 *
 * Pure.
 */

import { z } from "zod";
import type { SdkReasoning } from "@/lib/polar/routing";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { EFFORTS, type SdkToolChoice } from "@/lib/polar/compat/anthropic-request";

const textPart = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imagePart = z
    .object({
        type: z.literal("image_url"),
        image_url: z.union([z.string(), z.object({ url: z.string(), detail: z.string().optional() }).passthrough()])
    })
    .passthrough();
const filePart = z
    .object({
        type: z.literal("file"),
        file: z
            .object({ file_data: z.string().optional(), filename: z.string().optional() })
            .passthrough()
    })
    .passthrough();
const otherPart = z.object({ type: z.string() }).passthrough();
const part = z.union([textPart, imagePart, filePart, otherPart]);

const content = z.union([z.string(), z.array(part)]).nullish();

const toolCall = z
    .object({
        id: z.string().min(1),
        type: z.literal("function").default("function"),
        function: z.object({ name: z.string().min(1), arguments: z.string().default("") }).passthrough()
    })
    .passthrough();

const message = z.discriminatedUnion("role", [
    z.object({ role: z.literal("system"), content }).passthrough(),
    z.object({ role: z.literal("developer"), content }).passthrough(),
    z.object({ role: z.literal("user"), content }).passthrough(),
    z
        .object({
            role: z.literal("assistant"),
            content,
            tool_calls: z.array(toolCall).nullish(),
            reasoning_content: z.string().nullish()
        })
        .passthrough(),
    z.object({ role: z.literal("tool"), content, tool_call_id: z.string().min(1) }).passthrough()
]);
export type ChatMessage = z.infer<typeof message>;

const toolDefinition = z
    .object({
        type: z.literal("function"),
        function: z
            .object({
                name: z.string().min(1).max(200),
                description: z.string().optional(),
                parameters: z.record(z.unknown()).optional()
            })
            .passthrough()
    })
    .passthrough();

export const chatRequestSchema = z
    .object({
        model: z.string().trim().min(1).max(300),
        messages: z.array(message).min(1).max(10_000),
        tools: z.array(toolDefinition).max(1000).optional(),
        tool_choice: z
            .union([
                z.enum(["none", "auto", "required"]),
                z.object({ type: z.literal("function"), function: z.object({ name: z.string().min(1) }) }).passthrough()
            ])
            .optional(),
        max_tokens: z.number().int().positive().nullish(),
        max_completion_tokens: z.number().int().positive().nullish(),
        temperature: z.number().min(0).max(2).nullish(),
        top_p: z.number().min(0).max(1).nullish(),
        presence_penalty: z.number().min(-2).max(2).nullish(),
        frequency_penalty: z.number().min(-2).max(2).nullish(),
        seed: z.number().int().nullish(),
        stop: z.union([z.string(), z.array(z.string()).max(64)]).nullish(),
        n: z.literal(1).nullish(),
        stream: z.boolean().nullish(),
        stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullish(),
        reasoning_effort: z.string().nullish()
    })
    .passthrough();
export type ChatRequest = z.infer<typeof chatRequestSchema>;

type Content = z.infer<typeof content>;

const flatText = (value: Content): string =>
    typeof value === "string"
        ? value
        : (value ?? [])
              .map((entry) => (entry.type === "text" ? (entry as { text: string }).text : ""))
              .filter(Boolean)
              .join("\n");

type UserPart = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number];

function userContent(value: Content): string | UserPart[] {
    if (typeof value === "string" || !value) return value ?? "";
    return value.map((entry): UserPart => {
        if (entry.type === "text") return { type: "text", text: (entry as { text: string }).text };
        if (entry.type === "image_url") {
            const image = (entry as z.infer<typeof imagePart>).image_url;
            return { type: "image", image: new URL(typeof image === "string" ? image : image.url) };
        }
        if (entry.type === "file") {
            const file = (entry as z.infer<typeof filePart>).file;
            if (file.file_data?.startsWith("data:")) {
                const mediaType = file.file_data.slice(5, file.file_data.indexOf(";")) || "application/octet-stream";
                return { type: "file", data: new URL(file.file_data), mediaType, filename: file.filename };
            }
        }
        return { type: "text", text: JSON.stringify(entry) };
    });
}

/** A call's arguments as the object the model wrote, or the raw text when it
 *  does not parse: the provider replays what was said either way. */
function argumentsOf(text: string): unknown {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** The conversation as AI SDK messages. A tool result names its call by id;
 *  the tool's name comes from the assistant turn that made the call. */
export function chatToModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
    const names = new Map<string, string>();
    const out: ModelMessage[] = [];
    for (const entry of messages) {
        switch (entry.role) {
            case "system":
            case "developer": {
                const text = flatText(entry.content);
                if (text) out.push({ role: "system", content: text });
                break;
            }
            case "user":
                out.push({ role: "user", content: userContent(entry.content) });
                break;
            case "assistant": {
                const parts: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> = [];
                if (entry.reasoning_content) parts.push({ type: "reasoning", text: entry.reasoning_content });
                const text = flatText(entry.content);
                if (text) parts.push({ type: "text", text });
                for (const call of entry.tool_calls ?? []) {
                    names.set(call.id, call.function.name);
                    parts.push({
                        type: "tool-call",
                        toolCallId: call.id,
                        toolName: call.function.name,
                        input: argumentsOf(call.function.arguments)
                    });
                }
                if (parts.length > 0) out.push({ role: "assistant", content: parts });
                break;
            }
            case "tool": {
                const result = {
                    type: "tool-result" as const,
                    toolCallId: entry.tool_call_id,
                    toolName: names.get(entry.tool_call_id) ?? "unknown",
                    output: { type: "text" as const, value: flatText(entry.content) }
                };
                // Consecutive results belong to one tool message.
                const last = out.at(-1);
                if (last?.role === "tool") last.content.push(result);
                else out.push({ role: "tool", content: [result] });
                break;
            }
        }
    }
    return out;
}

export function chatToolsOf(tools: ChatRequest["tools"]): ToolSet | undefined {
    if (!tools || tools.length === 0) return undefined;
    const set: ToolSet = {};
    for (const definition of tools) {
        set[definition.function.name] = tool({
            description: definition.function.description,
            inputSchema: jsonSchema((definition.function.parameters ?? { type: "object", properties: {} }) as never)
        });
    }
    return set;
}

export function chatToolChoiceOf(choice: ChatRequest["tool_choice"]): SdkToolChoice | undefined {
    if (!choice) return undefined;
    if (typeof choice === "string") return choice;
    return { type: "tool", toolName: choice.function.name };
}

/** `reasoning_effort` as the AI SDK's level; an unknown value is the default. */
export function chatReasoning(request: Pick<ChatRequest, "reasoning_effort">): SdkReasoning | undefined {
    const raw = request.reasoning_effort?.trim().toLowerCase();
    return raw ? EFFORTS[raw] : undefined;
}
