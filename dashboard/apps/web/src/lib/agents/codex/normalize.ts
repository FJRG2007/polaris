/**
 * Codex app-server items as the session's history rows: the same shape
 * `transcript-decoders.ts` gives a line of a Codex rollout, so a session's
 * page reads a Chat turn and a terminal turn alike.
 *
 * `item/completed` carries the authoritative item (the docs: "treat this as
 * the authoritative state"), so a message is a row when its item completes,
 * whatever its deltas added up to. A tool is a row when its item starts and
 * its result another when it completes. Reasoning is never kept, as in the
 * decoders. Everything kept is cut to the decoders' bounds, and each row's id
 * is the item's own, so reading an item twice adds nothing.
 */

import {
    MAX_TEXT_CHARS,
    MAX_TOOL_RESULT_CHARS,
    toolInputSummary,
    type HistoryRow
} from "../transcript-decoders";
import { threadItemSchema, type ThreadItem } from "./protocol";

const MAX_SUBJECT_CHARS = 200;
const MAX_ID_CHARS = 128;

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An MCP result's text: its text content, else the whole of it as JSON. */
function mcpResultText(result: unknown, error: unknown): string {
    const failure = (error as { message?: unknown } | null | undefined)?.message;
    if (typeof failure === "string" && failure) return failure;
    const content = (result as { content?: unknown } | null | undefined)?.content;
    if (Array.isArray(content)) {
        const parts = content
            .map((part) => (part as { type?: unknown; text?: unknown })?.text)
            .filter((part): part is string => typeof part === "string");
        if (parts.length > 0) return parts.join("\n");
    }
    if (result === undefined || result === null) return "";
    try {
        return JSON.stringify(result);
    } catch {
        return "";
    }
}

/** Whether an item's final status is a failure. */
function failed(status: string): boolean {
    return status === "failed" || status === "declined";
}

/** One connection's rows. */
export class CodexNormalizer {
    private readonly announced = new Set<string>();
    private readonly finished = new Set<string>();
    private markers = 0;

    constructor(
        private readonly scope: string,
        private readonly now: () => number = Date.now
    ) {}

    /** The rows an `item/started` makes: a tool's call. */
    started(raw: unknown): HistoryRow[] {
        const item = this.read(raw);
        if (!item) return [];
        const call = this.call(item);
        return call ? [call] : [];
    }

    /** The rows an `item/completed` makes: a message, or a tool's result (and
     *  its call, when its start was never seen). */
    completed(raw: unknown): HistoryRow[] {
        const item = this.read(raw);
        if (!item) return [];
        const ref = clip(item.id, MAX_ID_CHARS);
        if (this.finished.has(ref)) return [];
        this.finished.add(ref);
        const rows: HistoryRow[] = [];
        const call = this.call(item);
        if (call) rows.push(call);
        switch (item.type) {
            case "userMessage": {
                const text = item.content
                    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
                    .join("")
                    .trim();
                if (text) rows.push(this.text(ref, "user", text));
                return rows;
            }
            case "agentMessage":
            case "plan": {
                const text = item.text.trim();
                if (text) rows.push(this.text(ref, "agent", text));
                return rows;
            }
            case "commandExecution":
                rows.push(this.result(ref, failed(item.status) || (item.exitCode ?? 0) !== 0, item.aggregatedOutput ?? ""));
                return rows;
            case "fileChange":
                rows.push(this.result(ref, failed(item.status), item.changes.map((change) => change.path).join("\n")));
                return rows;
            case "mcpToolCall":
                rows.push(this.result(ref, failed(item.status) || Boolean(item.error), mcpResultText(item.result, item.error)));
                return rows;
            case "webSearch":
                rows.push(this.result(ref, false, ""));
                return rows;
            case "contextCompaction":
                rows.push(this.marker(ref, "compacted"));
                return rows;
        }
    }

    /** The end of a turn. An interrupted one reads as the person stopping it. */
    finish(status: string, turnId: string): HistoryRow[] {
        if (status !== "interrupted") return [];
        this.markers += 1;
        return [this.marker(`${clip(turnId, MAX_ID_CHARS)}:${this.markers}`, "interrupted")];
    }

    private read(raw: unknown): ThreadItem | null {
        const parsed = threadItemSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
    }

    private call(item: ThreadItem): HistoryRow | null {
        const ref = clip(item.id, MAX_ID_CHARS);
        const tool = (): { subject: string; body: string } | null => {
            switch (item.type) {
                case "commandExecution":
                    return { subject: "shell", body: clip(item.command, 400) };
                case "fileChange":
                    return { subject: "apply_patch", body: toolInputSummary({ files: item.changes.map((change) => change.path) }) };
                case "mcpToolCall":
                    return { subject: `${item.server}/${item.tool}`, body: toolInputSummary(item.arguments) };
                case "webSearch":
                    return { subject: "web_search", body: clip(item.query, 400) };
                default:
                    return null;
            }
        };
        const described = tool();
        if (!described || this.announced.has(ref)) return null;
        this.announced.add(ref);
        return {
            vendorId: `${this.scope}:${ref}:call`,
            role: "agent",
            kind: "tool",
            subject: clip(described.subject.trim() || "tool", MAX_SUBJECT_CHARS),
            ref,
            body: described.body,
            at: this.now()
        };
    }

    private text(ref: string, role: "user" | "agent", body: string): HistoryRow {
        return {
            vendorId: `${this.scope}:${ref}:0`,
            role,
            kind: "text",
            subject: "",
            ref: "",
            body: clip(body, MAX_TEXT_CHARS),
            at: this.now()
        };
    }

    private result(ref: string, error: boolean, body: string): HistoryRow {
        return {
            vendorId: `${this.scope}:${ref}:result`,
            role: "agent",
            kind: "result",
            subject: error ? "error" : "",
            ref,
            body: clip(body.trim(), MAX_TOOL_RESULT_CHARS),
            at: this.now()
        };
    }

    private marker(ref: string, subject: "compacted" | "interrupted"): HistoryRow {
        return {
            vendorId: `${this.scope}:${ref}:${subject}`,
            role: "system",
            kind: "marker",
            subject,
            ref: "",
            body: "",
            at: this.now()
        };
    }
}
