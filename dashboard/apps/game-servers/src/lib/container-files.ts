/**
 * Reading and writing a game server's own files inside its container.
 *
 * Several of the things these panels offer are files rather than commands - the
 * settings a server boots with, its admin list, its survivor profiles, a FiveM
 * server's whole configuration - and no game here has a way of being asked about
 * any of them over its console. So they are read and written where they live.
 *
 * Through the container's own shell rather than through the daemon's file API:
 * that one only reaches containers on the local host, and a game server
 * registered on another machine is exactly the case that has to keep working.
 * `run` already works on both, so a write is a base64 blob handed to `base64 -d` -
 * the bytes never touch a shell as text, and the only thing interpolated into the
 * command is a path this module's callers own and a string of base64 characters.
 *
 * A write lands in a temporary file first and is then poured into the real one, so
 * a half-written file is never what the server boots from, and the file keeps
 * whatever ownership it already had - it is read by the game's own account, not by
 * the one this command runs as.
 */

import type { ServerContainer } from "./minecraft/service";

/** Paths are the callers' own constants, never anything typed. Proved rather than
 *  assumed, because everything below puts one in a shell command. */
export function assertSafePath(path: string): void {
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) {
        throw new Error("That is not a path Polaris will read");
    }
}

/**
 * What a read found, for a caller that has to tell an absent file from one it
 * could not see.
 *
 * `cat` exits non-zero for both, and they mean opposite things to anybody about
 * to write the file back: a file that is not there is an empty one, where a read
 * that failed - a container on its way down, an exec the machine refused - is a
 * file whose contents are still in there and would be written over by whatever
 * was built on the assumption it was empty. What `cat` complained about is the
 * only thing that separates them.
 */
export type ContainerFileRead =
    | { readonly state: "read"; readonly content: string }
    | { readonly state: "missing" }
    | { readonly state: "unreadable" };

/**
 * The most a `run` reports back. The host daemon cuts a command's output there
 * (`EXEC_RUN_MAX_OUTPUT` in polaris-hostd), without saying so, because that route
 * is meant for a status line - and a stats file, a whitelist or a stretch of log
 * is often longer. Offgrid's leaderboard named one player out of seven, the one
 * whose file came first, because the rest never arrived.
 */
export const RUN_OUTPUT_MAX = 16 * 1024;

/** Whether a `run` said everything, or may have been cut at `RUN_OUTPUT_MAX`. A
 *  few bytes short counts as cut: the daemon steps back to a character boundary. */
export function mayBeCut(output: string): boolean {
    return Buffer.byteLength(output, "utf8") >= RUN_OUTPUT_MAX - 4;
}

/** What reading a server's files needs of it. */
export type FileReader = Pick<ServerContainer, "run" | "readFile">;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const parts: Buffer[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
}

/** A file's bytes, whole, however long - for the ones that are not text. */
export async function readContainerBytes(server: Pick<ServerContainer, "readFile">, path: string): Promise<Buffer> {
    assertSafePath(path);
    return collect(await server.readFile(path));
}

export async function readContainerFileState(server: FileReader, path: string): Promise<ContainerFileRead> {
    assertSafePath(path);
    const result = await server.run(["cat", "--", path]);
    if (result.code === 0) {
        if (!mayBeCut(result.output)) return { state: "read", content: result.output };
        // Longer than a `run` carries: read it again whole, as a stream, which has
        // no such limit. A file written back from a cut read would be a cut file.
        const whole = await server
            .readFile(path)
            .then(collect)
            .catch(() => null);
        return whole ? { state: "read", content: whole.toString("utf8") } : { state: "unreadable" };
    }
    // Both spellings, because the images do not agree: coreutils says "No such
    // file or directory" and busybox prefixes it with "can't open".
    return /no such file|can't open/i.test(result.output) ? { state: "missing" } : { state: "unreadable" };
}

/** One of the server's files as text, or null when it is not there. A file that
 *  does not exist is not a failure: a server nobody has made an admin has no admin
 *  list, and a server that has never started has no settings file. */
export async function readContainerFile(server: FileReader, path: string): Promise<string | null> {
    const read = await readContainerFileState(server, path);
    return read.state === "read" ? read.content : null;
}

/** Files per command of `readContainerFiles`, however short they are. */
const FILES_PER_RUN = 64;

/**
 * Several of the server's files as text, by path, in as few commands as their
 * length allows: a command reads files, as base64, until its answer is full, and
 * the next one takes up at the first file that did not arrive whole. A file
 * longer than a whole answer is read on its own, as a stream. A file that is not
 * there or cannot be read is left out.
 */
export async function readContainerFiles(server: FileReader, paths: readonly string[]): Promise<Map<string, string>> {
    paths.forEach(assertSafePath);
    const read = new Map<string, string>();
    for (let next = 0; next < paths.length; ) {
        const batch = paths.slice(next, next + FILES_PER_RUN);
        const result = await server.run([
            "sh",
            "-c",
            `for f in ${batch.join(" ")}; do printf '@@%s\\n' "$f"; if [ -r "$f" ] && base64 < "$f"; then printf '@@.\\n'; else printf '@@!\\n'; fi; done`
        ]);
        if (result.code !== 0) break;
        const settled = new Set<string>();
        let current: string | null = null;
        let body: string[] = [];
        for (const line of result.output.split("\n")) {
            if (!line.startsWith("@@")) {
                if (current !== null) body.push(line);
                continue;
            }
            const tag = line.slice(2);
            if (current !== null && (tag === "." || tag === "!")) {
                if (tag === ".") read.set(current, Buffer.from(body.join(""), "base64").toString("utf8"));
                settled.add(current);
                current = null;
            } else {
                current = tag;
                body = [];
            }
        }
        const done = batch.findIndex((path) => !settled.has(path));
        const count = done < 0 ? batch.length : done;
        if (count > 0 || !mayBeCut(result.output)) {
            next += mayBeCut(result.output) ? count : batch.length;
            continue;
        }
        const whole = await readContainerBytes(server, batch[0]!).catch(() => null);
        if (whole) read.set(batch[0]!, whole.toString("utf8"));
        next += 1;
    }
    return read;
}

/** Bytes of a file per piece of `readContainerRange`: base64 of it, with its line
 *  breaks, stays under `RUN_OUTPUT_MAX`. */
const RANGE_PIECE = 11 * 1024;

/** Bytes `from` up to `to` of a file, in pieces a `run` can carry, or null when
 *  it cannot be read. */
async function readRangeBytes(
    server: Pick<ServerContainer, "run">,
    path: string,
    from: number,
    to: number
): Promise<Buffer | null> {
    assertSafePath(path);
    const parts: Buffer[] = [];
    for (let at = Math.max(0, Math.floor(from)); at < to; ) {
        const want = Math.min(RANGE_PIECE, Math.floor(to) - at);
        const result = await server.run([
            "sh",
            "-c",
            `tail -c +${at + 1} -- ${path} | head -c ${want} | base64`
        ]);
        if (result.code !== 0) return null;
        const piece = Buffer.from(result.output.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
        if (piece.length === 0) break;
        parts.push(piece);
        at += piece.length;
    }
    return Buffer.concat(parts);
}

/**
 * Part of a file - bytes `from` up to `to` - for the ones that are only ever
 * read in part, like a log that is hundreds of megabytes long. In pieces a
 * `run` can carry, each as base64 so a character split between two pieces is
 * put back together rather than lost. Null when it cannot be read.
 */
export async function readContainerRange(
    server: Pick<ServerContainer, "run">,
    path: string,
    from: number,
    to: number
): Promise<string | null> {
    const bytes = await readRangeBytes(server, path, from, to);
    return bytes === null ? null : bytes.toString("utf8");
}

/** How big a file is, in bytes, or null when it cannot be told. */
export async function containerFileSize(server: Pick<ServerContainer, "run">, path: string): Promise<number | null> {
    assertSafePath(path);
    const result = await server.run(["stat", "-c", "%s", "--", path]).catch(() => null);
    const size = result && result.code === 0 ? Number(result.output.trim()) : Number.NaN;
    return Number.isFinite(size) && size >= 0 ? size : null;
}

/** The last `bytes` of a file, or null when it cannot be read. */
export async function readContainerTail(
    server: Pick<ServerContainer, "run">,
    path: string,
    bytes: number
): Promise<string | null> {
    const size = await containerFileSize(server, path);
    if (size === null) return null;
    return readContainerRange(server, path, Math.max(0, size - bytes), size);
}

/**
 * The newest thing `find` sees in the last `bytes` of a file, read backward a
 * piece at a time and stopping at the first piece that has it - what is looked
 * for is usually near the end. Null when nothing matches or it cannot be read.
 */
export async function searchContainerTail<T>(
    server: Pick<ServerContainer, "run">,
    path: string,
    bytes: number,
    find: (text: string) => T | null
): Promise<T | null> {
    const size = await containerFileSize(server, path);
    if (size === null) return null;
    const floor = Math.max(0, size - bytes);
    const parts: Buffer[] = [];
    for (let start = size; start > floor; ) {
        const from = Math.max(floor, start - RANGE_PIECE);
        const piece = await readRangeBytes(server, path, from, start);
        if (piece === null) return null;
        if (piece.length === 0) break;
        parts.unshift(piece);
        start = from;
        let text = Buffer.concat(parts).toString("utf8");
        if (start > floor) {
            const newline = text.indexOf("\n");
            text = newline < 0 ? "" : text.slice(newline + 1);
        }
        const found = find(text);
        if (found !== null) return found;
    }
    return null;
}

/** Lines per page of `readLinesPaged` to begin with. A page that comes back as
 *  long as a `run` carries is read again as a smaller one. */
const LINES_PAGE = 150;

/**
 * Every line a listing command prints, however many, in pages a `run` can
 * carry. `listing` is a shell pipeline of the caller's own; it is sorted here so
 * each page takes up where the last one ended. Empty when it fails.
 */
export async function readLinesPaged(server: Pick<ServerContainer, "run">, listing: string): Promise<string[]> {
    const lines: string[] = [];
    let size = LINES_PAGE;
    for (let first = 1; ; ) {
        const result = await server.run([
            "sh",
            "-c",
            `{ ${listing}; } | LC_ALL=C sort | sed -n '${first},${first + size - 1}p'`
        ]);
        if (result.code !== 0) break;
        if (mayBeCut(result.output) && size > 1) {
            size = Math.max(1, Math.floor(size / 2));
            continue;
        }
        const page = result.output.split("\n").filter((line) => line.length > 0);
        lines.push(...page);
        if (page.length < size) break;
        first += size;
    }
    return lines;
}

/** Every entry in a folder, however many. Empty for a folder that is not there. */
export async function listContainerDir(server: Pick<ServerContainer, "run">, dir: string): Promise<string[]> {
    assertSafePath(dir);
    return readLinesPaged(server, `ls -1A -- ${dir} 2>/dev/null`);
}

/**
 * Write one of the server's files, keeping who owns it, in one step.
 *
 * The file is built beside the real one and then moved onto it. A move within a
 * directory is a rename: no reader ever sees half of it, and nothing is destroyed
 * until the new contents are complete on disk. That matters more than it used to,
 * because the files coming through here now include the ones the server is closed
 * by - and a `whitelist.json` caught halfway through a write is every player on it
 * locked out of a server that says they are welcome.
 *
 * Pouring into the existing file instead (`cat tmp > file`) truncates it before
 * writing a byte, so a command that dies midway - a container stopping, a
 * connection dropping, a full disk - leaves a short file or an empty one. The
 * reason it was written that way is real, though: a plain `mv` hands the file to
 * whoever ran the command, and the game's own account then cannot rewrite its
 * settings when it shuts down. So the owner and mode are copied onto the new file
 * from the one it replaces before the move, and taken from the folder when there
 * is nothing there to copy from.
 */
export async function writeContainerFile(server: ServerContainer, path: string, content: string): Promise<void> {
    assertSafePath(path);
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const temporary = `${path}.polaris-new`;
    // Ownership is copied rather than asked for with --reference, which busybox
    // does not carry. Never fatal: a file written but left owned by the wrong
    // account is a problem the next boot may survive, where refusing the write is
    // one it certainly will not.
    const takeOwner = `chown "$(stat -c %u:%g ${path})" ${temporary} || true; chmod "$(stat -c %a ${path})" ${temporary} || true`;
    const inheritOwner = `chown "$(stat -c %u:%g "$(dirname ${path})")" ${temporary} || true`;
    const script = [
        `mkdir -p "$(dirname ${path})"`,
        `printf %s ${encoded} | base64 -d > ${temporary}`,
        `if [ -f ${path} ]; then ${takeOwner}; else ${inheritOwner}; fi`,
        `mv -f ${temporary} ${path}`
    ].join(" && ");
    const result = await server.run(["sh", "-c", script]);
    if (result.code !== 0) {
        const said = result.output.trim().slice(0, 200);
        throw new Error(said.length > 0 ? `The server refused the write: ${said}` : "The file could not be written");
    }
}
