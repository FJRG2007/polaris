/**
 * The files in a session's checkout, for the workspace beside a Code thread.
 *
 * Read from the container while the session runs, so they are what the agent
 * has right now - saved or not. Both reads stream out of the container
 * (`readFile`) rather than through `runIn`, whose output is a capped string:
 * a repository's file list passes that cap long before it is large.
 *
 * A container session has these, and so does one on the person's own computer
 * whose desktop answers workspace reads (`computer-workspace.ts`). One on
 * somebody's own server is that server's files, and its shell is the way to them.
 *
 * The one file outside the checkout read here is a subagent's own transcript,
 * at the exact place Claude Code writes it (`subagentTranscriptPath`), and from
 * wherever the session lives.
 */

import * as core from "@polaris/core";
import { DEFAULT_WORKDIR } from "./session-work";
import { withContainerPorts } from "./session-ports";
import { sessionPlacement } from "./session-service";
import { runInSession } from "./session-runtime";
import { readTranscript } from "./session-transcript";
import { decodeClaudeSubagentLine, type HistoryRow } from "./transcript-decoders";
import { computerSessionRunner, readComputerWorkspace } from "@/lib/computers/computer-workspace";

/** The most files a list holds. Past this the list says it was cut. */
export const MAX_FILES = 20_000;
/** The largest file shown. A bigger one is named, not opened. */
export const MAX_FILE_BYTES = 512 * 1024;
/** The list is bounded in bytes too, before it is split into names. */
const MAX_LIST_BYTES = 4 * 1024 * 1024;

export type FilesAnswer =
    | { kind: "files"; paths: string[]; truncated: boolean }
    | { kind: "unavailable" };

export type FileAnswer =
    | { kind: "text"; path: string; text: string }
    | { kind: "binary"; path: string }
    | { kind: "tooLarge"; path: string; bytes: number }
    | { kind: "missing"; path: string }
    | { kind: "unavailable" };

/**
 * A path inside the checkout, or null. Relative, no step out of it, no
 * control characters - checked before anything is asked of the container,
 * because the path is a reader's input and the container is the agent's.
 */
export function checkoutPath(path: string): string | null {
    const trimmed = path.trim().replace(/^\.\/+/, "");
    if (!trimmed || trimmed.length > 1024 || trimmed.startsWith("/")) return null;
    if (core.hasControlCharacter(trimmed)) return null;
    if (trimmed.split("/").some((part) => part === ".." || part === "")) return null;
    return trimmed;
}

export async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | null> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}

export async function containerOf(sessionId: string) {
    const placement = await sessionPlacement(sessionId);
    if (!placement || placement.place !== "local" || !placement.containerId) return null;
    if (core.isSessionOver(placement.state)) return null;
    return {
        hostId: placement.hostId,
        containerId: placement.containerId,
        workdir: placement.workdir || DEFAULT_WORKDIR
    };
}

/** Every tracked and new file, ignored ones left out, as git sees them. */
export async function listSessionFiles(sessionId: string): Promise<FilesAnswer> {
    const runnerId = await computerSessionRunner(sessionId);
    if (runnerId) {
        const answer = await readComputerWorkspace({ id: sessionId, runnerId }, { kind: "files" });
        return answer?.kind === "files"
            ? { kind: "files", paths: [...answer.paths].sort(), truncated: answer.truncated }
            : { kind: "unavailable" };
    }
    const container = await containerOf(sessionId);
    if (!container) return { kind: "unavailable" };
    const listing = `/tmp/polaris-files-${sessionId}.txt`;
    try {
        return await withContainerPorts(container.hostId, async (ports) => {
            const listed = await ports.runIn(container.containerId, [
                "sh",
                "-c",
                'cd "$1" && git ls-files -co --exclude-standard > "$2"',
                "sh",
                container.workdir,
                listing
            ]);
            if (listed.code !== 0) return { kind: "unavailable" as const };
            const bytes = await readAll(
                await ports.readFile(container.containerId, listing),
                MAX_LIST_BYTES
            );
            if (!bytes) return { kind: "files" as const, paths: [], truncated: true };
            const all = bytes.toString("utf8").split("\n").filter(Boolean);
            return {
                kind: "files" as const,
                paths: all.slice(0, MAX_FILES).sort(),
                truncated: all.length > MAX_FILES
            };
        });
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not list its files:`, error);
        return { kind: "unavailable" };
    }
}

/** One file's text, or why it is not shown. */
export async function readSessionFile(sessionId: string, rawPath: string): Promise<FileAnswer> {
    const path = checkoutPath(rawPath);
    if (!path) return { kind: "missing", path: rawPath };
    const runnerId = await computerSessionRunner(sessionId);
    if (runnerId) return computerFile(await readComputerWorkspace({ id: sessionId, runnerId }, { kind: "file", path }), path);
    const container = await containerOf(sessionId);
    if (!container) return { kind: "unavailable" };
    try {
        return await withContainerPorts(container.hostId, async (ports) => {
            const sized = await ports.runIn(container.containerId, [
                "sh",
                "-c",
                'cd "$1" && [ -f "$2" ] && wc -c < "$2"',
                "sh",
                container.workdir,
                path
            ]);
            if (sized.code !== 0) return { kind: "missing" as const, path };
            const bytes = Number(sized.output.trim());
            if (Number.isFinite(bytes) && bytes > MAX_FILE_BYTES)
                return { kind: "tooLarge" as const, path, bytes };
            const body = await readAll(
                await ports.readFile(container.containerId, `${container.workdir}/${path}`),
                MAX_FILE_BYTES
            );
            if (!body) return { kind: "tooLarge" as const, path, bytes: MAX_FILE_BYTES + 1 };
            // A NUL in the first stretch is a binary file; drawing it as text
            // is a screen of replacement characters.
            if (body.subarray(0, 8000).includes(0)) return { kind: "binary" as const, path };
            return { kind: "text" as const, path, text: body.toString("utf8") };
        });
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not read ${path}:`, error);
        return { kind: "unavailable" };
    }
}

/** A computer's answer to a file read, in this module's words. Pure. */
export function computerFile(answer: core.WorkspaceAnswer | null, path: string): FileAnswer {
    switch (answer?.kind) {
        case "text":
            return { kind: "text", path, text: answer.text };
        case "binary":
            return { kind: "binary", path };
        case "tooLarge":
            return { kind: "tooLarge", path, bytes: answer.bytes };
        case "gone":
            return { kind: "missing", path };
        default:
            return { kind: "unavailable" };
    }
}

/** The most rows a subagent's transcript is shown with; past it, it says so. */
export const MAX_SUBAGENT_ROWS = 500;
/** Chunks of a subagent's transcript read at most (`TRANSCRIPT_CHUNK_BYTES` each). */
const SUBAGENT_CHUNKS = 48;

/** `~/.claude/projects/<project>/.../subagents/<agent>.jsonl`, from the home
 *  or absolute. A config home moved by `CLAUDE_CONFIG_DIR` is still a
 *  `.claude*` directory. No step up, nothing a shell would read. */
const SUBAGENT_TRANSCRIPT =
    /^(?:~|(?:\/[A-Za-z0-9._-]+)+)\/\.claude[A-Za-z0-9_-]*\/projects\/(?:[A-Za-z0-9._-]+\/)+subagents\/[A-Za-z0-9._-]+\.jsonl$/;

/**
 * A subagent transcript's path, or null for anything else. The path came from
 * a hook payload, which the agent's machine wrote; it is only ever read when
 * it is exactly where Claude Code keeps a subagent's transcript.
 */
export function subagentTranscriptPath(path: string | null | undefined): string | null {
    if (typeof path !== "string" || path.length > 1024) return null;
    if (core.hasControlCharacter(path)) return null;
    if (path.split("/").some((part) => part === ".." || part === ".")) return null;
    return SUBAGENT_TRANSCRIPT.test(path) ? path : null;
}

export type SubagentTranscriptAnswer =
    | { kind: "rows"; rows: HistoryRow[]; truncated: boolean }
    | { kind: "missing" }
    | { kind: "unavailable" };

type Run = (sessionId: string, script: string) => Promise<{ code: number; output: string }>;

/** A finished session's machine may still be there; the read says when not. */
const runEvenIfFinished: Run = (sessionId, script) =>
    runInSession(sessionId, script, { evenIfFinished: true });

/** A subagent's own conversation, read from its transcript on the session's machine. */
export async function readSubagentTranscript(
    sessionId: string,
    rawPath: string | null,
    run: Run = runEvenIfFinished
): Promise<SubagentTranscriptAnswer> {
    const path = subagentTranscriptPath(rawPath);
    if (!path) return { kind: "missing" };
    try {
        const read = await readTranscript(
            path,
            0,
            async (script) => (await run(sessionId, script)).output,
            { maxChunks: SUBAGENT_CHUNKS }
        );
        if (read.kind === "missing") return { kind: "missing" };
        if (read.kind === "failed") return { kind: "unavailable" };
        const rows: HistoryRow[] = [];
        let truncated = read.more;
        for (const line of read.lines) {
            const decoded = decodeClaudeSubagentLine(line.text);
            if (rows.length + decoded.length > MAX_SUBAGENT_ROWS) {
                truncated = true;
                break;
            }
            rows.push(...decoded);
        }
        return { kind: "rows", rows, truncated };
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not read a subagent transcript:`, error);
        return { kind: "unavailable" };
    }
}
