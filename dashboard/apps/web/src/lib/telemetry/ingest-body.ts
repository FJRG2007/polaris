/**
 * The body of a crash report, as text, whatever the client did to it on the way.
 *
 * Sentry clients compress: the Python SDK gzips every request by default, the Node
 * one gzips any body over 32 KiB, and some send `br` or `deflate`. Read as plain
 * text, those reports were dropped without a trace - the endpoint answers the same
 * thing whatever happens, so nobody could tell. Every encoding a client sends is
 * undone here, bounded twice: the bytes that arrive, and what they inflate to, so a
 * small compressed body cannot unpack into an unbounded one.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** Undo one `content-encoding`, or null for one this cannot read. */
function decode(bytes: Buffer, encoding: string, max: number): Buffer | null {
    const options = { maxOutputLength: max };
    switch (encoding) {
        case "":
        case "identity":
            return bytes;
        case "gzip":
        case "x-gzip":
            return gunzipSync(bytes, options);
        case "deflate":
            return inflateSync(bytes, options);
        case "br":
            return brotliDecompressSync(bytes, options);
        default:
            return null;
    }
}

/**
 * Decode a body to text, or null when it is empty, too large, in an encoding no
 * client sends, or damaged. Encodings are undone in reverse order of the header,
 * as HTTP lists them in the order they were applied.
 */
export function decodeIngestBody(bytes: Buffer, contentEncoding: string | null, max: number): string | null {
    if (bytes.length === 0 || bytes.length > max) return null;
    const encodings = (contentEncoding ?? "")
        .split(",")
        .map((one) => one.trim().toLowerCase())
        .filter(Boolean)
        .reverse();
    let current = bytes;
    try {
        for (const encoding of encodings) {
            const next = decode(current, encoding, max);
            if (!next) return null;
            current = next;
        }
    } catch {
        // Damaged, or inflating past the bound - either way not a report.
        return null;
    }
    if (current.length === 0 || current.length > max) return null;
    return current.toString("utf8");
}

/** Read a request's body as decoded text, within the bound. */
export async function readIngestBody(request: Request, max: number): Promise<string | null> {
    const bytes = await request.arrayBuffer().then(
        (buffer) => Buffer.from(buffer),
        () => null
    );
    if (!bytes) return null;
    return decodeIngestBody(bytes, request.headers.get("content-encoding"), max);
}
