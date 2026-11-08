/**
 * Reading an agent's own transcript, a piece at a time, from wherever its
 * session runs.
 *
 * The agent writes its conversation as JSON lines to a file on its machine, and
 * the only way to that machine is a command whose output the daemon cuts at
 * 16 KiB without saying so. So the file is read from a byte offset in base64
 * chunks of a fixed size, the same way `session-changes.ts` reads a diff: the
 * bytes are only turned into text once a whole line is here, so a character
 * split across two chunks still decodes. The offset only ever moves past a
 * complete line - a line the agent is still writing is read again next time.
 *
 * Modelled on Orca's incremental transcript reader (MIT,
 * github.com/stablyai/orca, src/main/native-chat/transcript-incremental-reader.ts).
 */

import * as core from "@polaris/core";
import { shellQuote } from "./session-hooks";

/** The line every script here starts its answer on. */
const MARK = "polaris-transcript:";

/** Raw bytes per chunk. Base64 makes it 14 668 characters, under the cap with
 *  room for the status line. */
export const TRANSCRIPT_CHUNK_BYTES = 11_000;

/** Chunks read per poll at most, so one poll is a bounded number of round trips. */
export const MAX_CHUNKS_PER_READ = 12;

/** A line longer than this is skipped rather than held: it is a tool result
 *  the size of a file, and the history shows a summary of those anyway. */
export const MAX_LINE_BYTES = 256 * 1024;

/**
 * Whether a stored transcript path is one this reader may open.
 *
 * The path came from a hook payload - the agent's own machine said it - so it is
 * held to the shape the agents that report one actually write: an absolute
 * `.jsonl` under a projects directory inside a `.claude` config home (or `.codex/sessions`). Never a
 * path from a request.
 */
export function readableTranscriptPath(path: string | null | undefined): path is string {
    if (!core.isTranscriptPath(path)) return false;
    if (!path.endsWith(".jsonl")) return false;
    // A config home moved by CLAUDE_CONFIG_DIR (Enigma sets one per account) is
    // still a `.claude*` directory with the projects under it.
    return (
        /\/\.claude[^/]*\/(?:[^/]+\/)*projects\/[^/]+\/[^/]+\.jsonl$/.test(path) ||
        /\/\.codex\/sessions\/(?:[^/]+\/)*[^/]+\.jsonl$/.test(path) ||
        /\/\.gemini\/tmp\/[^/]+\/chats\/[^/]+\.jsonl$/.test(path)
    );
}

/** The script that prints the file's size and one chunk from `offset`. */
export function transcriptChunkScript(path: string, offset: number): string {
    const from = Math.max(0, Math.floor(offset));
    return [
        `f=${shellQuote(path)}`,
        `[ -f "$f" ] || { echo "${MARK} missing"; exit 0; }`,
        "size=$(wc -c < \"$f\" | tr -d ' ')",
        `echo "${MARK} chunk $size"`,
        `tail -c +${from + 1} "$f" | head -c ${TRANSCRIPT_CHUNK_BYTES} | base64 | tr -d '\\n'`,
        "echo"
    ].join("\n");
}

/** The script that measures the line starting at `offset`, newline included,
 *  so a line too long to hold can be stepped over without reading it here. */
export function transcriptLineScript(path: string, offset: number): string {
    const from = Math.max(0, Math.floor(offset));
    return [
        `f=${shellQuote(path)}`,
        `[ -f "$f" ] || { echo "${MARK} missing"; exit 0; }`,
        "size=$(wc -c < \"$f\" | tr -d ' ')",
        `len=$(tail -c +${from + 1} "$f" | LC_ALL=C awk '{ print length($0) + 1; exit }')`,
        `echo "${MARK} line $size \${len:-0}"`
    ].join("\n");
}

export type TranscriptAnswer =
    | { kind: "chunk"; size: number; bytes: Buffer }
    | { kind: "line"; size: number; length: number }
    | { kind: "missing" };

/** What one of the scripts printed, or null when it never got as far as saying. */
export function parseTranscriptAnswer(output: string): TranscriptAnswer | null {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith(MARK));
    if (start < 0) return null;
    const [status, first, second] = lines[start]!.slice(MARK.length).trim().split(/\s+/);
    const number = (value: string | undefined) => {
        const parsed = Number.parseInt(value ?? "", 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    if (status === "missing") return { kind: "missing" };
    const size = number(first);
    if (size === null) return null;
    if (status === "line") {
        const length = number(second);
        return length === null ? null : { kind: "line", size, length };
    }
    if (status !== "chunk") return null;
    const body = (lines[start + 1] ?? "").trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
    return { kind: "chunk", size, bytes: Buffer.from(body, "base64") };
}

/** One complete line and the offset just past it. */
export interface TranscriptLine {
    readonly text: string;
    readonly end: number;
}

export type TranscriptRead =
    | {
          kind: "ok";
          /** Complete lines, in order. */
          lines: TranscriptLine[];
          /** Where the next read starts: past the last complete line. */
          next: number;
          /** Whether the file was shorter than the offset and was read from 0. */
          restarted: boolean;
          /** Lines stepped over for being too long to hold. */
          skipped: number;
          /** Whether the file goes on past what this read reached. */
          more: boolean;
      }
    | { kind: "missing" }
    | { kind: "failed" };

/**
 * Read the complete lines from `offset` on, through `run`.
 *
 * A file shorter than the offset was truncated or replaced, and is read again
 * from the start - what was already stored is keyed by the line's own id, so
 * reading it twice adds nothing. A chunk that came back shorter than it should
 * have was cut on the way, and the read stops at the last line it can vouch for.
 */
export async function readTranscript(
    path: string,
    offset: number,
    run: (script: string) => Promise<string>,
    {
        maxChunks = MAX_CHUNKS_PER_READ,
        maxLineBytes = MAX_LINE_BYTES
    }: { maxChunks?: number; maxLineBytes?: number } = {}
): Promise<TranscriptRead> {
    let restarted = false;
    let skipped = 0;
    const lines: TranscriptLine[] = [];
    let held: Buffer = Buffer.alloc(0);
    // The file offset of the first byte of `held`, and of the next byte to read.
    let heldAt = Math.max(0, Math.floor(offset));
    let at = heldAt;
    let size = 0;

    for (let chunk = 0; chunk < maxChunks; chunk++) {
        const answer = parseTranscriptAnswer(await run(transcriptChunkScript(path, at)));
        if (!answer || answer.kind === "line") break;
        if (answer.kind === "missing") return chunk === 0 ? { kind: "missing" } : done();
        size = answer.size;
        if (size < at) {
            // Shrunk under us. Only a first read starts over; a shrink mid-read
            // is left for the next poll to notice.
            if (chunk > 0 || restarted) return done();
            restarted = true;
            heldAt = at = 0;
            chunk--;
            continue;
        }
        const expected = Math.min(TRANSCRIPT_CHUNK_BYTES, size - at);
        if (answer.bytes.length < expected || answer.bytes.length === 0) break;
        held = held.length ? Buffer.concat([held, answer.bytes]) : answer.bytes;
        at += answer.bytes.length;

        let from = 0;
        for (let newline = held.indexOf(0x0a); newline >= 0; newline = held.indexOf(0x0a, from)) {
            const text = held.subarray(from, newline).toString("utf8").replace(/\r$/, "");
            lines.push({ text, end: heldAt + newline + 1 });
            from = newline + 1;
        }
        held = held.subarray(from);
        heldAt += from;

        if (held.length > maxLineBytes) {
            const line = parseTranscriptAnswer(await run(transcriptLineScript(path, heldAt)));
            if (!line || line.kind !== "line" || line.length <= 0) break;
            // Not finished being written: wait for it rather than skip half.
            if (heldAt + line.length > line.size) break;
            skipped++;
            heldAt = at = heldAt + line.length;
            held = Buffer.alloc(0);
        }
        if (at >= size) break;
    }
    return done();

    function done(): TranscriptRead {
        return { kind: "ok", lines, next: heldAt, restarted, skipped, more: heldAt < size };
    }
}
