/**
 * Answers to `transcript.read`: a piece of the agent's own transcript, for the
 * session's history on the server. Claude Code writes the conversation as
 * JSON lines under its projects folder (`~/.claude/projects`, or the one under
 * `CLAUDE_CONFIG_DIR`); the server asks for it a chunk at a time from the
 * offset it last stopped at, and for the length of a line too long to hold so
 * it can step over it.
 *
 * The path came from the agent's hook through the server, so it is opened
 * only when it is an absolute `.jsonl` whose real path (links followed) lies
 * inside one of those projects folders. Windows paths are native here.
 *
 * Pure apart from `TranscriptDeps`.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TRANSCRIPT_LIMITS, type TranscriptAnswer, type TranscriptQuery } from "../../../../dashboard/packages/core/src/runner-protocol";

export interface TranscriptDeps {
    /** The real path, links followed; throws for a missing one. */
    readonly realpath: (path: string) => Promise<string>;
    /** Size and kind, or null when missing. */
    readonly stat: (path: string) => Promise<{ size: number; file: boolean; } | null>;
    /** Up to `length` bytes from `offset`. */
    readonly read: (path: string, offset: number, length: number) => Promise<Buffer>;
}

/** Bytes read at a time while measuring a line. */
const LINE_SCAN_BYTES = 64 * 1024;
/** The longest line measured; one longer reads as not finished yet. */
const LINE_SCAN_MAX = 64 * 1024 * 1024;

/** The projects folders Claude Code may write transcripts under. */
export function transcriptRoots(env: Record<string, string | undefined>, home: string): string[] {
    const roots = [join(home, ".claude", "projects")];
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    if (configured && isAbsolute(configured)) roots.push(join(configured, "projects"));
    return [...new Set(roots)];
}

function within(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/** The real path of a transcript the server named, or null when it is not one
 *  this computer opens. */
export async function transcriptFile(path: string, roots: readonly string[], deps: TranscriptDeps): Promise<string | null> {
    if (!path || path.length > TRANSCRIPT_LIMITS.pathLength || /[\u0000-\u001f\u007f]/.test(path)) return null;
    if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
    let real: string;
    try {
        real = await deps.realpath(resolve(path));
    } catch {
        return null;
    }
    if (!real.endsWith(".jsonl")) return null;
    for (const root of roots) {
        const realRoot = await deps.realpath(root).catch(() => null);
        // Under a project's folder, never a file loose in `projects` itself.
        if (realRoot && within(realRoot, real) && relative(realRoot, real).split(sep).length >= 2) return real;
    }
    return null;
}

/** The length of the line starting at `offset`, newline included; 0 while it
 *  has no newline yet. */
async function lineLength(file: string, offset: number, size: number, deps: TranscriptDeps): Promise<number> {
    for (let at = offset; at < size && at - offset < LINE_SCAN_MAX; at += LINE_SCAN_BYTES) {
        const bytes = await deps.read(file, at, Math.min(LINE_SCAN_BYTES, size - at));
        if (bytes.length === 0) return 0;
        const newline = bytes.indexOf(0x0a);
        if (newline >= 0) return at - offset + newline + 1;
    }
    return 0;
}

/** One `transcript.read` answered, or `missing` for a session this computer
 *  does not hold, a refused path or a file that is not there. */
export async function readTranscriptPiece(
    held: boolean,
    path: string,
    query: TranscriptQuery,
    roots: readonly string[],
    deps: TranscriptDeps
): Promise<TranscriptAnswer> {
    if (!held) return { kind: "missing" };
    const file = await transcriptFile(path, roots, deps);
    if (!file) return { kind: "missing" };
    const stat = await deps.stat(file);
    if (!stat?.file) return { kind: "missing" };
    const size = stat.size;
    if (query.kind === "line") return { kind: "line", size, length: query.offset < size ? await lineLength(file, query.offset, size, deps) : 0 };
    const length = Math.max(0, Math.min(TRANSCRIPT_LIMITS.chunkBytes, size - query.offset));
    const bytes = length > 0 ? await deps.read(file, query.offset, length) : Buffer.alloc(0);
    return { kind: "chunk", size, data: bytes.subarray(0, TRANSCRIPT_LIMITS.chunkBytes).toString("base64") };
}
