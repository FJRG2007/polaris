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
 * is the sweep that bounds it, and it is deliberately written to be a no-op
 * where it is not allowed to write: an installation whose web container still
 * mounts the log read-only keeps working exactly as it does now.
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

/** Above this the log is trimmed. Two orders of magnitude more than any window
 *  read here, so trimming is rare and never takes a window with it. */
const TRIM_ABOVE_BYTES = 256 * 1024 * 1024;

/** What a trim leaves behind - enough that every reader's window is still whole
 *  immediately afterwards. */
const KEEP_ON_TRIM_BYTES = 32 * 1024 * 1024;

/**
 * The last `bytes` of the log, as text, with the partial first line dropped.
 *
 * Empty for every failure, which is the honest answer for all of them: no log
 * mounted, an edge that lives on another machine, a file that has not been
 * written yet. A caller cannot act on the difference.
 */
export async function readEdgeLogTail(bytes = EDGE_LOG_WINDOW_BYTES): Promise<string> {
    let handle: FileHandle | null = null;
    try {
        handle = await open(accessLog(), "r");
        const { size } = await handle.stat();
        const want = Math.min(bytes, size);
        if (want <= 0) return "";
        const from = size - want;
        const buffer = Buffer.alloc(want);
        await handle.read(buffer, 0, want, from);
        const text = buffer.toString("utf8");
        // A read that started mid-file started mid-line, and half a JSON object
        // is not something to hand a parser.
        return from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } catch {
        return "";
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
 * Returns the bytes reclaimed, or zero when there was nothing to do - including
 * when the log is mounted read-only, which is what an installation that has not
 * been updated yet still does. It fails closed and silently for that reason.
 */
export async function trimEdgeLog(cap = TRIM_ABOVE_BYTES): Promise<number> {
    let handle: FileHandle | null = null;
    try {
        handle = await open(accessLog(), "r+");
        const { size } = await handle.stat();
        if (size <= cap) return 0;

        const keep = Math.min(KEEP_ON_TRIM_BYTES, size);
        const buffer = Buffer.alloc(keep);
        await handle.read(buffer, 0, keep, size - keep);
        // From the first whole line in what was kept.
        const start = buffer.indexOf(0x0a) + 1;
        const kept = keep - start;

        await handle.truncate(0);
        if (kept > 0) await handle.write(buffer, start, kept, 0);
        return size - kept;
    } catch {
        return 0;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
