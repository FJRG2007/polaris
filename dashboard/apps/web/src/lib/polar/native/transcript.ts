/**
 * The native engine's transcript, written in Claude Code's JSONL shape so
 * history rows come from the decoder Polaris already has (`decodeClaudeLine`
 * in lib/agents/transcript-decoders.ts): one record per line, a uuid each,
 * text and tool_use blocks on assistant lines, tool_result blocks on user
 * lines, a `compact_boundary` system line and an interruption line.
 */

import { randomUUID } from "node:crypto";

export interface TranscriptBlockText {
    readonly type: "text";
    readonly text: string;
}
export interface TranscriptBlockToolUse {
    readonly type: "tool_use";
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
}
export interface TranscriptBlockToolResult {
    readonly type: "tool_result";
    readonly tool_use_id: string;
    readonly content: string;
    readonly is_error?: boolean;
}
export type TranscriptBlock = TranscriptBlockText | TranscriptBlockToolUse | TranscriptBlockToolResult;

export interface TranscriptRecord {
    readonly type: "user" | "assistant" | "system";
    readonly uuid: string;
    readonly parentUuid: string | null;
    readonly sessionId: string;
    readonly timestamp: string;
    readonly isSidechain: boolean;
    readonly cwd: string;
    readonly subtype?: string;
    readonly content?: string;
    readonly message?: {
        readonly role: "user" | "assistant";
        readonly content: readonly TranscriptBlock[];
        readonly model?: string;
    };
}

type RecordBody = Pick<TranscriptRecord, "type" | "subtype" | "content" | "message">;

export const INTERRUPTED_TEXT = "[Request interrupted by user]";

export class TranscriptWriter {
    private last: string | null = null;

    constructor(
        private readonly sessionId: string,
        private readonly cwd: () => string,
        private readonly write: (line: string) => void,
        private readonly sidechain = false,
        private readonly now: () => Date = () => new Date()
    ) {}

    private emit(body: RecordBody): string {
        const uuid = randomUUID();
        const record: TranscriptRecord = {
            ...body,
            uuid,
            parentUuid: this.last,
            sessionId: this.sessionId,
            timestamp: this.now().toISOString(),
            isSidechain: this.sidechain,
            cwd: this.cwd()
        };
        this.last = uuid;
        this.write(JSON.stringify(record));
        return uuid;
    }

    user(text: string): string {
        return this.emit({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    }

    assistant(blocks: readonly TranscriptBlock[], model: string): string | null {
        if (blocks.length === 0) return null;
        return this.emit({ type: "assistant", message: { role: "assistant", content: blocks, model } });
    }

    toolResults(results: readonly TranscriptBlockToolResult[]): string | null {
        if (results.length === 0) return null;
        return this.emit({ type: "user", message: { role: "user", content: results } });
    }

    compacted(): string {
        return this.emit({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" });
    }

    interrupted(): string {
        return this.emit({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: INTERRUPTED_TEXT }] }
        });
    }
}
