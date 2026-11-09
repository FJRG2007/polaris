/**
 * The files in a session's checkout, for the workspace beside a Code thread.
 *
 * Read from the container while the session runs, so they are what the agent
 * has right now - saved or not. Both reads stream out of the container
 * (`readFile`) rather than through `runIn`, whose output is a capped string:
 * a repository's file list passes that cap long before it is large.
 *
 * Only a container session has these. One on somebody's own server is that
 * server's files, and its shell is the way to them.
 */

import * as core from "@polaris/core";
import { DEFAULT_WORKDIR } from "./session-work";
import { withContainerPorts } from "./session-ports";
import { sessionPlacement } from "./session-service";

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

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | null> {
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

async function containerOf(sessionId: string) {
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
