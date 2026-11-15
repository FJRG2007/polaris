/**
 * Agent Client Protocol updates as the session's history rows: the same shape
 * `transcript-decoders.ts` gives a transcript line, so the session page reads
 * both alike.
 *
 * An agent streams a message as chunks; a row is a whole message, so chunks are
 * gathered until something else arrives (or the turn ends) and then kept as one
 * row. Thinking is never kept, as in the decoders. A tool call is a row when it
 * is announced and its result another once it completes or fails. Everything
 * kept is cut to the decoders' bounds. The SDK has already parsed each update
 * against the protocol's schema; this only reads what it needs.
 */

import type * as acp from "@agentclientprotocol/sdk";
import {
    MAX_TEXT_CHARS,
    MAX_TOOL_RESULT_CHARS,
    toolInputSummary,
    type HistoryRow,
    type HistoryRole
} from "../transcript-decoders";

const MAX_SUBJECT_CHARS = 200;
const MAX_ID_CHARS = 128;

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function blockText(block: acp.ContentBlock | undefined): string {
    return block && block.type === "text" ? block.text : "";
}

/** A tool's result as text: its text content, else its raw output summarised. */
function toolResultText(update: { content?: acp.ToolCallContent[] | null; rawOutput?: unknown }): string {
    const parts: string[] = [];
    for (const item of update.content ?? []) {
        if (item.type === "content") parts.push(blockText(item.content));
        else if (item.type === "diff") parts.push(item.path);
    }
    const text = parts.filter(Boolean).join("\n");
    if (text) return text;
    if (update.rawOutput === undefined || update.rawOutput === null) return "";
    if (typeof update.rawOutput === "string") return update.rawOutput;
    try {
        return JSON.stringify(update.rawOutput);
    } catch {
        return "";
    }
}

interface Pending {
    role: HistoryRole;
    id: string;
    text: string;
}

/**
 * Turns one session's updates into rows. One per connection: ids are unique
 * within the agent's session, which is what makes a re-read add nothing.
 */
export class AcpNormalizer {
    private pending: Pending | null = null;
    private segment = 0;
    private readonly calls = new Map<string, { title: string; announced: boolean; done: boolean }>();

    constructor(
        private readonly sessionId: string,
        private readonly now: () => number = Date.now
    ) {}

    /** The rows an update completes. */
    push(update: acp.SessionUpdate): HistoryRow[] {
        const rows: HistoryRow[] = [];
        switch (update.sessionUpdate) {
            case "agent_message_chunk":
            case "user_message_chunk": {
                const role: HistoryRole = update.sessionUpdate === "agent_message_chunk" ? "agent" : "user";
                const id = update.messageId ? clip(update.messageId, MAX_ID_CHARS) : null;
                if (this.pending && (this.pending.role !== role || (id && this.pending.id !== id)))
                    rows.push(...this.flush());
                if (!this.pending) {
                    this.segment += 1;
                    this.pending = { role, id: id ?? `${this.sessionId}:${this.segment}`, text: "" };
                }
                if (this.pending.text.length < MAX_TEXT_CHARS) this.pending.text += blockText(update.content);
                return rows;
            }
            case "agent_thought_chunk":
                return rows;
            case "tool_call": {
                rows.push(...this.flush());
                const ref = clip(update.toolCallId, MAX_ID_CHARS);
                const known = this.calls.get(ref);
                if (!known || !known.announced) {
                    this.calls.set(ref, { title: update.title, announced: true, done: false });
                    rows.push(this.callRow(ref, update.title, update.rawInput));
                }
                if (update.status === "completed" || update.status === "failed")
                    rows.push(...this.resultRow(ref, update));
                return rows;
            }
            case "tool_call_update": {
                rows.push(...this.flush());
                const ref = clip(update.toolCallId, MAX_ID_CHARS);
                const known = this.calls.get(ref);
                if (!known?.announced && update.title) {
                    this.calls.set(ref, { title: update.title, announced: true, done: false });
                    rows.push(this.callRow(ref, update.title, update.rawInput));
                }
                if (update.status === "completed" || update.status === "failed")
                    rows.push(...this.resultRow(ref, update));
                return rows;
            }
            default:
                return rows;
        }
    }

    /** The end of a turn: the message being gathered is whole, and a cancelled
     *  turn reads as one the person interrupted. */
    finish(stopReason?: acp.StopReason): HistoryRow[] {
        const rows = this.flush();
        if (stopReason === "cancelled") {
            this.segment += 1;
            rows.push({
                vendorId: `${this.sessionId}:${this.segment}:interrupted`,
                role: "system",
                kind: "marker",
                subject: "interrupted",
                ref: "",
                body: "",
                at: this.now()
            });
        }
        return rows;
    }

    private flush(): HistoryRow[] {
        const pending = this.pending;
        this.pending = null;
        if (!pending) return [];
        const text = pending.text.trim();
        if (!text) return [];
        return [
            {
                vendorId: `${pending.id}:0`,
                role: pending.role,
                kind: "text",
                subject: "",
                ref: "",
                body: clip(text, MAX_TEXT_CHARS),
                at: this.now()
            }
        ];
    }

    private callRow(ref: string, title: string, rawInput: unknown): HistoryRow {
        return {
            vendorId: `${ref}:call`,
            role: "agent",
            kind: "tool",
            subject: clip(title.trim() || "tool", MAX_SUBJECT_CHARS),
            ref,
            body: toolInputSummary(rawInput),
            at: this.now()
        };
    }

    private resultRow(
        ref: string,
        update: { status?: acp.ToolCallStatus | null; content?: acp.ToolCallContent[] | null; rawOutput?: unknown }
    ): HistoryRow[] {
        const known = this.calls.get(ref);
        if (known?.done) return [];
        if (known) known.done = true;
        else this.calls.set(ref, { title: "", announced: false, done: true });
        return [
            {
                vendorId: `${ref}:result`,
                role: "agent",
                kind: "result",
                subject: update.status === "failed" ? "error" : "",
                ref,
                body: clip(toolResultText(update).trim(), MAX_TOOL_RESULT_CHARS),
                at: this.now()
            }
        ];
    }
}
