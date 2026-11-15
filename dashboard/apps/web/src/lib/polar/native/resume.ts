/**
 * Resume and fork: a native conversation read back from its own transcript.
 *
 * The transcript is the Claude-shaped JSONL the engine writes
 * (`transcript.ts`), so it is both what the history rows decode and what a
 * later process continues from. A headless session runs every prompt as its
 * own process (the runner's `launch.sh --turn`), so each turn starts by
 * replaying this file; a fork replays its parent's file into a new one.
 *
 * Only the main thread is replayed (sidechain lines are a subagent's own
 * work), and only from the last compaction on: what came before it is the
 * summary line written right after the boundary.
 *
 * Server-free: no Polaris import, so it bundles into the session process.
 */

import type { ModelMessage } from "ai";
import { INTERRUPTED_TEXT } from "@/lib/polar/native/transcript";

interface Block {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly id?: unknown;
    readonly name?: unknown;
    readonly input?: unknown;
    readonly tool_use_id?: unknown;
    readonly content?: unknown;
    readonly is_error?: unknown;
}

interface Line {
    readonly type?: unknown;
    readonly subtype?: unknown;
    readonly isSidechain?: unknown;
    readonly isCompactSummary?: unknown;
    readonly message?: { readonly role?: unknown; readonly content?: unknown };
}

function parse(line: string): Line | null {
    try {
        const value: unknown = JSON.parse(line);
        return value && typeof value === "object" ? (value as Line) : null;
    } catch {
        return null;
    }
}

function blocksOf(line: Line): Block[] {
    const content = line.message?.content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    return Array.isArray(content) ? content.filter((block): block is Block => Boolean(block) && typeof block === "object") : [];
}

/** The conversation a transcript holds, as the model reads it. Malformed lines
 *  are skipped; a call left without a result gets one, so the next request is
 *  well formed for every provider. */
export function replayTranscript(text: string): ModelMessage[] {
    const lines = text
        .split("\n")
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map(parse)
        .filter((line): line is Line => line !== null && line.isSidechain !== true);
    let start = 0;
    lines.forEach((line, index) => {
        if (line.type === "system" && line.subtype === "compact_boundary") start = index + 1;
    });
    const messages: ModelMessage[] = [];
    const names = new Map<string, string>();
    let open: string[] = [];
    const closeOpen = () => {
        if (open.length === 0) return;
        messages.push({
            role: "tool",
            content: open.map((id) => ({
                type: "tool-result" as const,
                toolCallId: id,
                toolName: names.get(id) ?? "unknown",
                output: { type: "error-text" as const, value: "Interrupted by the user before it finished." }
            }))
        });
        open = [];
    };
    for (const line of lines.slice(start)) {
        const blocks = blocksOf(line);
        if (line.type === "assistant") {
            closeOpen();
            const parts: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> = [];
            for (const block of blocks) {
                if (block.type === "text" && typeof block.text === "string" && block.text) {
                    parts.push({ type: "text", text: block.text });
                } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                    names.set(block.id, block.name);
                    open.push(block.id);
                    parts.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.input ?? {} });
                }
            }
            if (parts.length > 0) messages.push({ role: "assistant", content: parts });
            continue;
        }
        if (line.type !== "user") continue;
        const results = blocks.filter((block) => block.type === "tool_result" && typeof block.tool_use_id === "string");
        if (results.length > 0) {
            messages.push({
                role: "tool",
                content: results.map((block) => {
                    const id = block.tool_use_id as string;
                    const value = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
                    return {
                        type: "tool-result" as const,
                        toolCallId: id,
                        toolName: names.get(id) ?? "unknown",
                        output: block.is_error === true
                            ? { type: "error-text" as const, value }
                            : { type: "text" as const, value }
                    };
                })
            });
            open = open.filter((id) => !results.some((block) => block.tool_use_id === id));
            continue;
        }
        const text = blocks
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
            .join("\n");
        if (!text) continue;
        closeOpen();
        messages.push({ role: "user", content: text === INTERRUPTED_TEXT ? INTERRUPTED_TEXT : text });
    }
    closeOpen();
    return messages;
}

/** A conversation id as hooks report it and the Resume button types it back:
 *  letters, digits and dashes only (`isVendorSessionId`). */
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
