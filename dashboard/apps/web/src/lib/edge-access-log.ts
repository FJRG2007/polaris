/**
 * The edge's access log, read without reading it.
 *
 * Traefik writes one JSON line per request into a file on a volume, and four
 * separate things here live off the last few megabytes of it: the fail2ban half
 * of the firewall, the anomaly pass, the firewall's own traffic screens, and the
 * analytics every deployed service gets without a script tag.
 *
 * Each of those used to hold its own copy of "read the tail", and each of those
 * copies was `readFile(path, "utf8")` followed by a slice - the whole file into
 * one string, and then throw nearly all of it away. That is not a bounded read
 * however small the window afterwards is, and past a certain size it is not a
 * read at all: Node cannot make a string longer than about half a gigabyte, so
 * the call throws `Invalid string length`, and every one of those four callers
 * caught it and carried on with an empty window.
 *
 * The symptom is the worst kind. Nothing errors on screen. Analytics simply
 * count nothing, the jails simply ban nobody, and the firewall's traffic view is
 * simply empty - on the instances with the most traffic, because those are the
 * ones whose log got big. A log of 1.6 GB was what it took to find it.
 *
 * So the tail is read as a tail: open the file, ask how big it is, and read the
 * last N bytes at that offset. The cost of one pass is the window, whatever the
 * file has grown to.
 *
 * The other half is that nothing was keeping the file down. Traefik does not
 * rotate its own log, so it grows until the disk is full - and a machine with no
 * room left cannot pull an image, which is where this was found. `trimEdgeLog`
 * is the sweep that bounds it. Writing to a file the edge creates as root takes
 * the group the edge's own entrypoint puts on it (see docker-compose.yml); where
 * that has not happened yet the trim fails closed and says so once.
 */

import { open, type FileHandle } from "node:fs/promises";

/** Where the edge writes it. The variable exists for a deployment whose edge is
 *  somewhere else; the default is the volume the compose file mounts. Read per
 *  call rather than held: a module constant is fixed at import, which makes the
 *  path something only the process start can decide. */
function accessLog(): string {
    return process.env.POLARIS_TRAEFIK_ACCESSLOG ?? "/traefik-log/access.log";
}

/** What a caller gets when it does not say. Sized for a day of traffic on a busy
 *  instance; the callers that want a narrower window pass one. */
export const EDGE_LOG_WINDOW_BYTES = 16 * 1024 * 1024;

/** The narrow window, for the passes that judge minutes rather than a day - the
 *  jails and the anomaly detector. Named here rather than repeated at each of
 *  them so the two sizes in use cannot drift into four. */
export const EDGE_LOG_RECENT_WINDOW_BYTES = 4 * 1024 * 1024;

/** Above this the log is trimmed. Two orders of magnitude more than any window
 *  read here, so trimming is rare and never takes a window with it. */
const TRIM_ABOVE_BYTES = 256 * 1024 * 1024;

/** What a trim leaves behind - enough that every reader's window is still whole
 *  immediately afterwards. */
const KEEP_ON_TRIM_BYTES = 32 * 1024 * 1024;

/** Said once per process, not once an hour: a trim that cannot write is a
 *  standing condition, and repeating it hourly buries the log it is written
 *  into. */
let trimFailureReported = false;

/**
 * Fill `buffer` from `from`, looping until it is full or the file ends.
 *
 * `read` is allowed to return fewer bytes than asked for, and `Buffer.alloc`
 * zero-fills, so trusting the requested length hands the parser a run of NUL
 * bytes - and, in the trim, writes them into the log in place of the newest
 * lines. Returns how many bytes are actually in the buffer.
 */
async function fill(handle: FileHandle, buffer: Buffer, from: number): Promise<number> {
    let filled = 0;
    while (filled < buffer.length) {
        const chunk = buffer.length - filled;
        const { bytesRead } = await handle.read(buffer, filled, chunk, from + filled);
        if (bytesRead <= 0) break;
        filled += bytesRead;
    }
    return filled;
}

/**
 * The last `bytes` of the log, as text, with the partial first line dropped.
 *
 * Empty for every failure, which is the honest answer for all of them: no log
 * mounted, an edge that lives on another machine, a file that has not been
 * written yet. A caller cannot act on the difference.
 */
export async function readEdgeLogTail(bytes = EDGE_LOG_WINDOW_BYTES): Promise<string> {
    return (await readEdgeLogWindow(bytes)).text;
}

/**
 * `readEdgeLogTail`, and whether the log holds more than was read: a window cut
 * at `bytes` covers less time because the log is busy, not because it is new.
 */
export async function readEdgeLogWindow(
    bytes = EDGE_LOG_WINDOW_BYTES
): Promise<{ readonly text: string; readonly truncated: boolean }> {
    let handle: FileHandle | null = null;
    try {
        handle = await open(accessLog(), "r");
        const { size } = await handle.stat();
        const want = Math.min(bytes, size);
        if (want <= 0) return { text: "", truncated: false };
        const from = size - want;
        const buffer = Buffer.alloc(want);
        const filled = await fill(handle, buffer, from);
        if (filled <= 0) return { text: "", truncated: false };
        const text = buffer.toString("utf8", 0, filled);
        if (from === 0) return { text, truncated: false };
        // A read that started mid-file started mid-line, and half a JSON object
        // is not something to hand a parser. A window with no newline in it at
        // all is one line's middle and nothing else, so it is all dropped.
        const newline = text.indexOf("\n");
        return { text: newline < 0 ? "" : text.slice(newline + 1), truncated: true };
    } catch {
        return { text: "", truncated: false };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * Keep the log from filling the disk.
 *
 * Truncated in place and rewritten with its own tail, rather than renamed: the
 * edge is holding the file open, and a rename leaves it writing into a file
 * nothing can see any more, on space nothing can reclaim until it is restarted.
 * Truncating keeps the same inode, so the next line it appends lands in the file
 * everything here is reading.
 *
 * Returns the bytes reclaimed, or zero when there was nothing to do. A log that
 * is not there and a log on a read-only mount are both "nothing to do" and stay
 * silent; anything else is reported once per process, because a trim that can
 * never succeed is otherwise invisible to an operator who never opens a
 * terminal.
 */
export async function trimEdgeLog(cap = TRIM_ABOVE_BYTES): Promise<number> {
    let handle: FileHandle | null = null;
    try {
        handle = await open(accessLog(), "r+");
        const { size } = await handle.stat();
        if (size <= cap) return 0;

        // Bounded by the cap as well as by the window: keeping more than the cap
        // would leave the file over it again the moment the next line lands.
        const keep = Math.min(KEEP_ON_TRIM_BYTES, cap, size);
        const buffer = Buffer.alloc(keep);
        const filled = await fill(handle, buffer, size - keep);
        // From the first whole line in what was kept. The window always starts
        // mid-file here (keep is under size), so a window with no newline in it
        // holds no whole line and nothing is kept.
        const newline = buffer.subarray(0, filled).indexOf(0x0a);
        const kept = newline < 0 ? 0 : filled - (newline + 1);

        await handle.truncate(0);
        if (kept > 0) await handle.write(buffer, newline + 1, kept, 0);
        return size - kept;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!trimFailureReported && code !== "ENOENT" && code !== "EROFS") {
            trimFailureReported = true;
            console.warn(
                `polaris: the edge access log could not be trimmed (${code ?? "unknown error"})`
            );
        }
        return 0;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
