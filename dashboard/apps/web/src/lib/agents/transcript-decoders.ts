/**
 * Turning a line of an agent's transcript into what the session page shows.
 *
 * A line is text from a program reading somebody's repository, so it is parsed
 * against a schema, everything kept from it is cut to a bound, and a line this
 * build does not recognise is skipped rather than guessed at. Thinking is never
 * kept: it is the agent's scratch work, not something it said.
 *
 * The Claude Code shape follows Orca's decoder (MIT, github.com/stablyai/orca,
 * src/main/native-chat/transcript-line-decoders-claude.ts and
 * transcript-record-blocks.ts).
 */

import { z } from "zod";

export type HistoryRole = "user" | "agent" | "system";
export type HistoryKind = "text" | "tool" | "result" | "marker";

/** One row of history, before it is stored. */
export interface HistoryRow {
    /** The line's own id and the block's place in it: what makes a re-read add
     *  nothing. */
    readonly vendorId: string;
    readonly role: HistoryRole;
    readonly kind: HistoryKind;
    /** The tool's name for a tool call, the marker's name for a marker. */
    readonly subject: string;
    /** The tool call a call or its result belongs to. */
    readonly ref: string;
    readonly body: string;
    /** When the agent wrote the line, in epoch milliseconds, or null when it
     *  did not say. */
    readonly at: number | null;
}

/** The markers a transcript can carry. Each has a sentence on the page. */
export const HISTORY_MARKERS = ["compacted", "interrupted"] as const;
export type HistoryMarker = (typeof HISTORY_MARKERS)[number];

/** The longest text kept from one message. */
export const MAX_TEXT_CHARS = 12_000;
/** The longest summary of what a tool was asked to do. */
export const MAX_TOOL_INPUT_CHARS = 400;
/** The longest piece of what a tool answered. */
export const MAX_TOOL_RESULT_CHARS = 2_000;
const MAX_ID_CHARS = 128;

export type TranscriptDecoder = (line: string) => HistoryRow[];

/**
 * The decoder for an agent's transcript, or null when there is none.
 *
 * Only Claude Code's hooks report a transcript path today (only it is given
 * Polaris's hook settings), so it is the only agent with a decoder. Codex
 * writes `~/.codex/sessions/.../rollout-*.jsonl`, but nothing records that path
 * yet; its decoder belongs here once something does.
 */
export function transcriptDecoder(cli: string): TranscriptDecoder | null {
    if (cli === "claude") return decodeClaudeLine;
    if (cli === "codex") return decodeCodexLine;
    if (cli === "gemini") return decodeGeminiLine;
    return null;
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How much of a prompt two copies of it are compared on. */
const PROMPT_KEY_CHARS = 2_000;

/**
 * A prompt as two copies of it are compared: the one typed in Polaris and the
 * one the transcript gives back, which may be clipped, carry other line endings
 * or space a slash command's arguments differently.
 */
export function promptKey(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, PROMPT_KEY_CHARS).replace(/…$/, "").trimEnd();
}

const idSchema = z.string().min(1).max(MAX_ID_CHARS);

const blockSchema = z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
        type: z.literal("tool_use"),
        id: idSchema.optional(),
        name: z.string().max(200),
        input: z.unknown()
    }),
    z.object({
        type: z.literal("tool_result"),
        tool_use_id: idSchema.optional(),
        content: z.unknown(),
        is_error: z.boolean().optional()
    }),
    z.object({ type: z.string() })
]);

const claudeLineSchema = z.object({
    type: z.string(),
    uuid: idSchema.optional(),
    timestamp: z.string().max(64).optional(),
    subtype: z.string().optional(),
    isMeta: z.boolean().optional(),
    isSidechain: z.boolean().optional(),
    isCompactSummary: z.boolean().optional(),
    interruptedMessageId: z.string().optional(),
    message: z
        .object({
            content: z.union([z.string(), z.array(z.unknown())])
        })
        .optional()
});

/** What Claude Code puts in a user turn that nobody typed. */
const INJECTED =
    /^<(local-command-stdout|local-command-stderr|system-reminder|command-message|bash-stdout|bash-stderr)>/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

/** A slash command reads as what was typed: `/name args`. */
function userText(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || INJECTED.test(trimmed)) return null;
    const name = /<command-name>([^<]*)<\/command-name>/.exec(trimmed);
    if (name) {
        const args = /<command-args>([^<]*)<\/command-args>/.exec(trimmed)?.[1]?.trim();
        const command = name[1]!.trim();
        return args ? `${command} ${args}` : command || null;
    }
    return trimmed;
}

/** The part of a tool's input a person would recognise it by. */
export function toolInputSummary(input: unknown): string {
    if (typeof input === "string") return clip(input, MAX_TOOL_INPUT_CHARS);
    if (!input || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    for (const key of [
        "command",
        "file_path",
        "pattern",
        "path",
        "url",
        "query",
        "description",
        "prompt"
    ]) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return clip(value.trim(), MAX_TOOL_INPUT_CHARS);
    }
    try {
        return clip(JSON.stringify(input), MAX_TOOL_INPUT_CHARS);
    } catch {
        return "";
    }
}

/** A tool result's content as one string: a string, or text blocks joined. */
function resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const item of content) {
        if (typeof item === "string") parts.push(item);
        else if (
            item &&
            typeof item === "object" &&
            typeof (item as { text?: unknown }).text === "string"
        )
            parts.push((item as { text: string }).text);
    }
    return parts.join("\n");
}

/** One line of a Claude Code transcript, as rows. Unknown lines give none. */
export function decodeClaudeLine(line: string): HistoryRow[] {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return [];
    }
    const parsed = claudeLineSchema.safeParse(raw);
    if (!parsed.success) return [];
    const record = parsed.data;
    const id = record.uuid;
    // No id is no way to store it once; a subagent's turns are its own.
    if (!id || record.isSidechain) return [];
    const stamped = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    const at = Number.isFinite(stamped) ? stamped : null;

    const marker = (subject: HistoryMarker): HistoryRow[] => [
        { vendorId: `${id}:0`, role: "system", kind: "marker", subject, ref: "", body: "", at }
    ];

    if (record.type === "system")
        return record.subtype === "compact_boundary" ? marker("compacted") : [];
    if (record.type !== "user" && record.type !== "assistant") return [];
    if (record.type === "user" && record.isCompactSummary) return [];
    if (record.type === "user" && record.interruptedMessageId) return marker("interrupted");

    const content = record.message?.content;
    if (content === undefined) return [];
    const items = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const rows: HistoryRow[] = [];
    items.forEach((item, index) => {
        const block = blockSchema.safeParse(item);
        if (!block.success) return;
        const vendorId = `${id}:${index}`;
        const value = block.data;
        if (value.type === "text" && "text" in value) {
            if (record.type === "user") {
                if (record.isMeta) return;
                if (INTERRUPTED.test(value.text.trim())) {
                    rows.push({
                        vendorId,
                        role: "system",
                        kind: "marker",
                        subject: "interrupted",
                        ref: "",
                        body: "",
                        at
                    });
                    return;
                }
                const text = userText(value.text);
                if (text)
                    rows.push({
                        vendorId,
                        role: "user",
                        kind: "text",
                        subject: "",
                        ref: "",
                        body: clip(text, MAX_TEXT_CHARS),
                        at
                    });
                return;
            }
            const text = value.text.trim();
            if (text)
                rows.push({
                    vendorId,
                    role: "agent",
                    kind: "text",
                    subject: "",
                    ref: "",
                    body: clip(text, MAX_TEXT_CHARS),
                    at
                });
            return;
        }
        if (value.type === "tool_use" && "name" in value && record.type === "assistant") {
            rows.push({
                vendorId,
                role: "agent",
                kind: "tool",
                subject: clip(value.name, 200),
                ref: value.id ?? "",
                body: toolInputSummary(value.input),
                at
            });
            return;
        }
        if (value.type === "tool_result" && "content" in value && record.type === "user") {
            rows.push({
                vendorId,
                role: "agent",
                kind: "result",
                subject: value.is_error ? "error" : "",
                ref: value.tool_use_id ?? "",
                body: clip(resultText(value.content).trim(), MAX_TOOL_RESULT_CHARS),
                at
            });
        }
        // thinking, redacted_thinking, image and anything newer: not kept.
    });
    return rows;
}
// ---------------------------------------------------------------------------
// Codex: the rollout file, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
// ---------------------------------------------------------------------------

/**
 * A stable id for a line that carries none of its own.
 *
 * Codex's rollout lines have no id, and the history is stored once per id, so
 * the id has to come out the same every time the same line is read. The line's
 * own hash does that; two lines with the same bytes are the same line.
 */
function lineId(prefix: string, line: string): string {
    // Two FNV-1a passes with different seeds, in plain code rather than
    // node:crypto: this module is also imported by the browser for `promptKey`.
    const fnv = (seed: number): string => {
        let hash = seed >>> 0;
        for (let index = 0; index < line.length; index++) {
            hash ^= line.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    };
    return `${prefix}${fnv(0x811c9dc5)}${fnv(0x9e3779b9)}${line.length.toString(16)}`;
}

const codexLineSchema = z.object({
    timestamp: z.string().max(64).optional(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()).optional()
});

/** What Codex writes into a user turn that the person never typed. */
const CODEX_INJECTED = /^(<[a-z_]+>|# AGENTS\.md instructions)/;

function codexText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) =>
            item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
                ? (item as { text: string }).text
                : ""
        )
        .filter(Boolean)
        .join("\n");
}

function codexOutput(output: unknown): string {
    if (typeof output === "string") return output;
    if (output && typeof output === "object" && !Array.isArray(output)) {
        const content = (output as { content?: unknown }).content;
        return typeof content === "string" ? content : codexText(content);
    }
    return codexText(output);
}

function codexArguments(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function asString(value: unknown, max: number): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * One line of a Codex rollout: `{ timestamp, type, payload }`, where the turns
 * are `response_item` lines - messages, tool calls and their outputs - and the
 * rest is metadata, except a compaction and an aborted turn.
 */
export function decodeCodexLine(line: string): HistoryRow[] {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return [];
    }
    const parsed = codexLineSchema.safeParse(raw);
    if (!parsed.success) return [];
    const { type, payload = {}, timestamp } = parsed.data;
    const stamped = timestamp ? Date.parse(timestamp) : Number.NaN;
    const at = Number.isFinite(stamped) ? stamped : null;
    const vendorId = lineId("cx:", line);
    const row = (partial: Omit<HistoryRow, "vendorId" | "at">): HistoryRow[] => [
        { vendorId, at, ...partial }
    ];

    if (type === "compacted")
        return row({ role: "system", kind: "marker", subject: "compacted", ref: "", body: "" });
    if (type === "event_msg")
        return payload.type === "turn_aborted"
            ? row({ role: "system", kind: "marker", subject: "interrupted", ref: "", body: "" })
            : [];
    if (type !== "response_item") return [];

    switch (payload.type) {
        case "message": {
            const text = codexText(payload.content).trim();
            if (!text) return [];
            if (payload.role === "user") {
                if (CODEX_INJECTED.test(text)) return [];
                return row({
                    role: "user",
                    kind: "text",
                    subject: "",
                    ref: "",
                    body: clip(text, MAX_TEXT_CHARS)
                });
            }
            if (payload.role !== "assistant") return [];
            return row({
                role: "agent",
                kind: "text",
                subject: "",
                ref: "",
                body: clip(text, MAX_TEXT_CHARS)
            });
        }
        case "function_call":
        case "custom_tool_call": {
            const name = asString(payload.name, 200);
            if (!name) return [];
            const input =
                payload.type === "function_call"
                    ? codexArguments(payload.arguments)
                    : payload.input;
            return row({
                role: "agent",
                kind: "tool",
                subject: name,
                ref: asString(payload.call_id, MAX_ID_CHARS),
                body: toolInputSummary(input)
            });
        }
        case "function_call_output":
        case "custom_tool_call_output":
            return row({
                role: "agent",
                kind: "result",
                subject: "",
                ref: asString(payload.call_id, MAX_ID_CHARS),
                body: clip(codexOutput(payload.output).trim(), MAX_TOOL_RESULT_CHARS)
            });
        default:
            return [];
    }
}

// ---------------------------------------------------------------------------
// Gemini CLI: `~/.gemini/tmp/<project>/chats/session-*.jsonl`
// ---------------------------------------------------------------------------

const geminiToolSchema = z.object({
    id: idSchema,
    name: z.string().max(200),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    status: z.string().optional(),
    displayName: z.string().max(200).optional()
});

const geminiLineSchema = z.object({
    id: idSchema,
    timestamp: z.string().max(64).optional(),
    type: z.string().optional(),
    content: z.unknown().optional(),
    toolCalls: z.array(z.unknown()).optional()
});

/** Text out of Gemini's part lists: a string, `{ text }`, or a list of either. */
function geminiText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(geminiText).filter(Boolean).join("\n");
    if (!content || typeof content !== "object") return "";
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    const response = (record.functionResponse as { response?: unknown } | undefined)?.response;
    const output =
        response && typeof response === "object"
            ? (response as { output?: unknown }).output
            : undefined;
    return typeof output === "string" ? output : "";
}

/**
 * One line of a Gemini CLI conversation file.
 *
 * The file is appended to, not rewritten: the first line is the conversation's
 * own metadata (no message id, so nothing here), each message is a line, and a
 * message that changes later - a tool call that finished - is appended again
 * under the same id. The text keeps the id it was first stored under, and each
 * tool call and its result carry ids of their own, so a later copy of the same
 * message adds only what is new.
 */
export function decodeGeminiLine(line: string): HistoryRow[] {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return [];
    }
    const parsed = geminiLineSchema.safeParse(raw);
    if (!parsed.success) return [];
    const record = parsed.data;
    const stamped = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    const at = Number.isFinite(stamped) ? stamped : null;
    const rows: HistoryRow[] = [];

    const text = geminiText(record.content).trim();
    if (text && (record.type === "user" || record.type === "gemini")) {
        rows.push({
            vendorId: `${record.id}:text`,
            role: record.type === "user" ? "user" : "agent",
            kind: "text",
            subject: "",
            ref: "",
            body: clip(text, MAX_TEXT_CHARS),
            at
        });
    }
    for (const item of record.toolCalls ?? []) {
        const tool = geminiToolSchema.safeParse(item);
        if (!tool.success) continue;
        const call = tool.data;
        rows.push({
            vendorId: `${record.id}:tool:${call.id}`,
            role: "agent",
            kind: "tool",
            subject: clip(call.displayName ?? call.name, 200),
            ref: call.id,
            body: toolInputSummary(call.args),
            at
        });
        if (call.result === undefined || call.result === null) continue;
        rows.push({
            vendorId: `${record.id}:result:${call.id}`,
            role: "agent",
            kind: "result",
            subject: call.status === "error" ? "error" : "",
            ref: call.id,
            body: clip(geminiText(call.result).trim(), MAX_TOOL_RESULT_CHARS),
            at
        });
    }
    return rows;
}
