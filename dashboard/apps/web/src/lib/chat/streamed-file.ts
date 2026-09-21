/**
 * Handing a file back without holding it.
 *
 * Every route that serves a conversation's files used to read the whole thing
 * into memory and slice the answer out of it - which is what a range request on a
 * video did too, so scrubbing a one-gigabyte recording read a gigabyte off the
 * NAS for every drag of the bar. It was also the other half of why a file could
 * not be bigger than a hundred megabytes: a limit on what one request may cost
 * the server is a limit on the read as much as on the write.
 *
 * So the bytes go from the storage to the reader a chunk at a time. What that
 * costs is one open session per response, which outlives the handler - the bytes
 * leave long after it returns - so the session is handed to the stream and given
 * back when the last byte does, or when the reader walks away. That is
 * `pipeThenDispose`, shared with Drive, which had the same problem first.
 *
 * Opened twice before giving up. A read can fail for a reason that has nothing to
 * do with the file - a handle another request left open a second ago, a session
 * the server has just reaped, a share reconnecting - and one retry turns most of
 * those into a pause nobody notices. Only the open is retried: once a byte has
 * been sent there is nothing to retry into.
 */

import { pipeThenDispose } from "@/lib/drive-stream";
import { rangeOf, type ByteRange } from "@/lib/http-range";
import { driverForTarget, LOCAL_TARGET } from "@/lib/storage-target";

/** Which folder under the data directory a chat file lives in, when the storage
 *  is this server. */
const LOCAL_FOLDER = "chat";

export type StreamedFile =
    | {
          readonly ok: true;
          readonly body: ReadableStream<Uint8Array>;
          /** The whole file, as the storage measures it. */
          readonly total: number;
          /** What is actually in the body: the range asked for, or null for all of
           *  it - which is also the answer when a range was asked for and this
           *  storage cannot start part-way through a file. */
          readonly range: ByteRange | null;
      }
    | { readonly ok: false; readonly why: "gone" | "unsatisfiable" };

/**
 * Open one stored file for one response.
 *
 * @param what How to name it in the log line, for the failures worth a line.
 */
export async function streamStored(
    where: { readonly connectionId: string | null; readonly path: string },
    rangeHeader: string | null,
    what: string
): Promise<StreamedFile> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const driver = await driverForTarget(
            where.connectionId ?? LOCAL_TARGET,
            LOCAL_FOLDER
        ).catch((error: unknown) => {
            console.error(`chat: the storage holding ${what} would not open:`, error);
            return null;
        });
        if (!driver) continue;

        let opened = false;
        try {
            const stat = await driver.stat(where.path);
            if (stat.kind !== "file") return { ok: false, why: "gone" };
            const total = Number(stat.size);

            const asked = rangeOf(rangeHeader, total);
            if (asked === "unsatisfiable") return { ok: false, why: "unsatisfiable" };

            // A range on a storage that cannot seek is answered with the whole
            // file rather than refused: a player that asked for the first megabyte
            // and got everything plays; one that got a 416 does not.
            const range = asked && driver.capabilities.randomRead ? asked : null;
            const stream = range
                ? await driver.readStream(where.path, { start: range.from, end: range.to })
                : await driver.readStream(where.path);

            opened = true;
            return { ok: true, body: pipeThenDispose(stream, driver), total, range };
        } catch (error) {
            // The last attempt is the one that is worth a line: the first is
            // ordinary, and a log that says everything says nothing.
            if (attempt === 1) console.error(`chat: ${what} could not be read:`, error);
        } finally {
            // A stream owns the session from here; anything else has finished with
            // it now.
            if (!opened) await driver.dispose().catch(() => undefined);
        }
    }
    return { ok: false, why: "gone" };
}

/** The headers a partial answer needs, so no route writes `content-range` by
 *  hand. */
export function rangeHeaders(file: Extract<StreamedFile, { ok: true }>): Record<string, string> {
    if (!file.range) return { "Content-Length": String(file.total) };
    return {
        "Content-Range": `bytes ${file.range.from}-${file.range.to}/${file.total}`,
        "Content-Length": String(file.range.to - file.range.from + 1)
    };
}
