/**
 * The OpenAI Responses request (platform.openai.com/docs/api-reference/responses),
 * the API Codex speaks, read and turned into AI SDK messages and tools. Covers
 * what free-claude-code's `core/openai_responses/models.py` and
 * `provider_input.py` accept from a coding client:
 *
 * - `instructions`, and `input` as a string or as items: `message` (system,
 *   developer, user, assistant; `input_text`, `output_text`, `input_image`,
 *   `input_file`, `refusal`), `function_call` / `function_call_output`,
 *   `custom_tool_call` / `custom_tool_call_output`, and `reasoning` (its text
 *   replayed; an `encrypted_content` only the issuing provider can read is
 *   dropped).
 * - `function` tools, and `custom` tools (Codex's free-form `apply_patch`),
 *   which no chat provider declares: free-claude-code sends them as a
 *   function taking one `input` string and hands the string back as a
 *   `custom_tool_call` (`tool_adaptation.py`). Hosted tools (`web_search`,
 *   `file_search`, ...) run on OpenAI's side and are left out.
 * - `tool_choice`, `reasoning.effort`, `max_output_tokens`, `temperature`,
 *   `top_p`.
 *
 * Nothing is stored here, so `previous_response_id` cannot be resolved and is
 * refused; Codex sends the whole conversation with `store: false`.
 *
 * Pure.
 */

import { z } from "zod";
import type { SdkReasoning } from "@/lib/polar/routing";
import { EFFORTS, type SdkToolChoice } from "@/lib/polar/compat/anthropic-request";
import { jsonSchema, tool, type ModelMessage, type ToolResultPart, type ToolSet } from "ai";

const contentPart = z.object({ type: z.string() }).passthrough();
const messageItem = z
    .object({
        type: z.literal("message").optional(),
        role: z.enum(["system", "developer", "user", "assistant"]),
        content: z.union([z.string(), z.array(contentPart)])
    })
    .passthrough();
const functionCall = z
    .object({
        type: z.literal("function_call"),
        call_id: z.string().min(1),
        name: z.string().min(1),
        arguments: z.string().default("")
    })
    .passthrough();
const functionOutput = z
    .object({
        type: z.literal("function_call_output"),
        call_id: z.string().min(1),
        output: z.union([z.string(), z.array(contentPart)])
    })
    .passthrough();
const customCall = z
    .object({
        type: z.literal("custom_tool_call"),
        call_id: z.string().min(1),
        name: z.string().min(1),
        input: z.string().default("")
    })
    .passthrough();
const customOutput = z
    .object({
        type: z.literal("custom_tool_call_output"),
        call_id: z.string().min(1),
        output: z.union([z.string(), z.array(contentPart)])
    })
    .passthrough();
const reasoningItem = z
    .object({
        type: z.literal("reasoning"),
        summary: z.array(z.object({ text: z.string() }).passthrough()).optional(),
        content: z.array(z.object({ text: z.string() }).passthrough()).nullish()
    })
    .passthrough();
/** Anything else (`item_reference`, hosted tool calls): skipped. */
const otherItem = z.object({ type: z.string() }).passthrough();

const item = z.union([messageItem, functionCall, functionOutput, customCall, customOutput, reasoningItem, otherItem]);
export type ResponsesItem = z.infer<typeof item>;

const toolDefinition = z.object({ type: z.string(), name: z.string().min(1).max(200).optional() }).passthrough();

export const responsesRequestSchema = z
    .object({
        model: z.string().trim().min(1).max(300),
        input: z.union([z.string(), z.array(item).max(10_000)]),
        instructions: z.string().nullish(),
        tools: z.array(toolDefinition).max(1000).optional(),
        tool_choice: z
            .union([
                z.enum(["none", "auto", "required"]),
                z.object({ type: z.enum(["function", "custom"]), name: z.string().min(1) }).passthrough(),
                z.object({ type: z.string() }).passthrough()
            ])
            .optional(),
        parallel_tool_calls: z.boolean().nullish(),
        reasoning: z.object({ effort: z.string().nullish() }).passthrough().nullish(),
        max_output_tokens: z.number().int().positive().nullish(),
        temperature: z.number().min(0).max(2).nullish(),
        top_p: z.number().min(0).max(1).nullish(),
        stream: z.boolean().nullish(),
        store: z.boolean().nullish(),
        previous_response_id: z.string().nullish(),
        metadata: z.record(z.unknown()).nullish()
    })
    .passthrough();
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

/** The one parameter a custom tool is declared with (free-claude-code
 *  `tool_adaptation.py`). */
export const CUSTOM_INPUT = "input";

/** The names of the custom tools, whose calls go back as `custom_tool_call`. */
export function customToolNames(tools: ResponsesRequest["tools"]): Set<string> {
    return new Set((tools ?? []).filter((entry) => entry.type === "custom" && entry.name).map((entry) => entry.name!));
}

export function responsesToolsOf(tools: ResponsesRequest["tools"]): ToolSet | undefined {
    const set: ToolSet = {};
    for (const definition of tools ?? []) {
        if (!definition.name) continue;
        const description = typeof definition.description === "string" ? definition.description : undefined;
        if (definition.type === "function") {
            const parameters = (definition.parameters as Record<string, unknown> | undefined) ?? {
                type: "object",
                properties: {}
            };
            set[definition.name] = tool({ description, inputSchema: jsonSchema(parameters as never) });
        } else if (definition.type === "custom") {
            set[definition.name] = tool({
                description,
                inputSchema: jsonSchema({
                    type: "object",
                    properties: { [CUSTOM_INPUT]: { type: "string", description: "The raw input for this tool." } },
                    required: [CUSTOM_INPUT]
                } as never)
            });
        }
    }
    return Object.keys(set).length > 0 ? set : undefined;
}

export function responsesToolChoiceOf(choice: ResponsesRequest["tool_choice"]): SdkToolChoice | undefined {
    if (!choice) return undefined;
    if (typeof choice === "string") return choice;
    const named = choice as { type: string; name?: unknown };
    return typeof named.name === "string" ? { type: "tool", toolName: named.name } : undefined;
}

export function responsesReasoning(request: Pick<ResponsesRequest, "reasoning">): SdkReasoning | undefined {
    const raw = request.reasoning?.effort?.trim().toLowerCase();
    return raw ? EFFORTS[raw] : undefined;
}

type UserPart = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number];
type AssistantPart = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number];

const textOf = (parts: readonly object[]) =>
    parts
        .map((part) => {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
        })
        .filter(Boolean)
        .join("\n");

function userParts(content: string | readonly { type: string }[]): string | UserPart[] {
    if (typeof content === "string") return content;
    return content.flatMap((part): UserPart[] => {
        const entry = part as Record<string, unknown>;
        if ((part.type === "input_text" || part.type === "output_text") && typeof entry.text === "string") {
            return [{ type: "text", text: entry.text }];
        }
        if (part.type === "input_image" && typeof entry.image_url === "string") {
            return [{ type: "image", image: new URL(entry.image_url) }];
        }
        if (part.type === "input_file" && typeof entry.file_data === "string") {
            const data = entry.file_data;
            const mediaType = data.startsWith("data:") ? data.slice(5, data.indexOf(";")) : "application/pdf";
            return [
                {
                    type: "file",
                    data: data.startsWith("data:") ? new URL(data) : data,
                    mediaType: mediaType || "application/octet-stream",
                    filename: typeof entry.filename === "string" ? entry.filename : undefined
                }
            ];
        }
        return [];
    });
}

function outputOf(output: string | readonly { type: string }[]): ToolResultPart["output"] {
    return { type: "text", value: typeof output === "string" ? output : textOf(output) };
}

function argumentsOf(text: string): unknown {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * The conversation as AI SDK messages. Consecutive assistant-side items
 * (reasoning, text, calls) are one assistant turn and consecutive outputs one
 * tool turn, the shape every provider expects.
 */
export function responsesToModelMessages(request: Pick<ResponsesRequest, "input" | "instructions">): ModelMessage[] {
    const out: ModelMessage[] = [];
    if (request.instructions) out.push({ role: "system", content: request.instructions });
    if (typeof request.input === "string") {
        out.push({ role: "user", content: request.input });
        return out;
    }
    const names = new Map<string, string>();
    const assistant = (part: AssistantPart) => {
        const last = out.at(-1);
        if (last?.role === "assistant" && typeof last.content !== "string") last.content.push(part);
        else out.push({ role: "assistant", content: [part] });
    };
    const result = (part: ToolResultPart) => {
        const last = out.at(-1);
        if (last?.role === "tool") last.content.push(part);
        else out.push({ role: "tool", content: [part] });
    };
    for (const entry of request.input) {
        const value = entry as Record<string, unknown>;
        switch (entry.type) {
            case "function_call":
            case "custom_tool_call": {
                const call = value as { call_id: string; name: string; arguments?: string; input?: string };
                names.set(call.call_id, call.name);
                assistant({
                    type: "tool-call",
                    toolCallId: call.call_id,
                    toolName: call.name,
                    input:
                        entry.type === "custom_tool_call"
                            ? { [CUSTOM_INPUT]: call.input ?? "" }
                            : argumentsOf(call.arguments ?? "")
                });
                break;
            }
            case "function_call_output":
            case "custom_tool_call_output": {
                const output = value as { call_id: string; output: string | { type: string }[] };
                result({
                    type: "tool-result",
                    toolCallId: output.call_id,
                    toolName: names.get(output.call_id) ?? "unknown",
                    output: outputOf(output.output)
                });
                break;
            }
            case "reasoning": {
                const thought = value as { summary?: { text: string }[]; content?: { text: string }[] | null };
                const text = textOf([...(thought.content ?? []), ...(thought.summary ?? [])]);
                if (text) assistant({ type: "reasoning", text });
                break;
            }
            case "message":
            case undefined: {
                const message = value as z.infer<typeof messageItem>;
                if (!("role" in value)) break;
                if (message.role === "system" || message.role === "developer") {
                    const text = typeof message.content === "string" ? message.content : textOf(message.content);
                    if (text) out.push({ role: "system", content: text });
                } else if (message.role === "assistant") {
                    const text = typeof message.content === "string" ? message.content : textOf(message.content);
                    if (text) assistant({ type: "text", text });
                } else {
                    out.push({ role: "user", content: userParts(message.content) });
                }
                break;
            }
            default:
                // A message item may omit its type; anything else is skipped.
                if ("role" in value && "content" in value) {
                    out.push({ role: "user", content: userParts(value.content as string) });
                }
        }
    }
    return out;
}
