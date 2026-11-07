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
    return cli === "claude" ? decodeClaudeLine : null;
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
const INJECTED = /^<(local-command-stdout|local-command-stderr|system-reminder|command-message|bash-stdout|bash-stderr)>/;
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
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return clip(value.trim(), MAX_TOOL_INPUT_CHARS);
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
        else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string")
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

    const marker = (subject: HistoryMarker): HistoryRow[] => [
        { vendorId: `${id}:0`, role: "system", kind: "marker", subject, ref: "", body: "" }
    ];

    if (record.type === "system") return record.subtype === "compact_boundary" ? marker("compacted") : [];
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
                    rows.push({ vendorId, role: "system", kind: "marker", subject: "interrupted", ref: "", body: "" });
                    return;
                }
                const text = userText(value.text);
                if (text) rows.push({ vendorId, role: "user", kind: "text", subject: "", ref: "", body: clip(text, MAX_TEXT_CHARS) });
                return;
            }
            const text = value.text.trim();
            if (text) rows.push({ vendorId, role: "agent", kind: "text", subject: "", ref: "", body: clip(text, MAX_TEXT_CHARS) });
            return;
        }
        if (value.type === "tool_use" && "name" in value && record.type === "assistant") {
            rows.push({
                vendorId,
                role: "agent",
                kind: "tool",
                subject: clip(value.name, 200),
                ref: value.id ?? "",
                body: toolInputSummary(value.input)
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
                body: clip(resultText(value.content).trim(), MAX_TOOL_RESULT_CHARS)
            });
        }
        // thinking, redacted_thinking, image and anything newer: not kept.
    });
    return rows;
}
