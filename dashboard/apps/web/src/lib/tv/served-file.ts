/**
 * A file this instance verified for a TV, streamed back with a single
 * `Range: bytes=` honoured so an interrupted download resumes. The ETag is the
 * file's SHA-256, so an `If-Range` for any other file is answered whole.
 */

import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { rangeOf } from "@/lib/http-range";

export interface VerifiedFile {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly contentType: string;
    readonly fileName: string;
}

export function servedFile(request: Request, file: VerifiedFile): Response {
    const etag = `"${file.sha256}"`;
    const headers: Record<string, string> = {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "accept-ranges": "bytes",
        etag,
        "cache-control": "no-store"
    };
    const range = rangeOf(request.headers.get("range"), file.size);
    if (range === "unsatisfiable") {
        return new Response(null, {
            status: 416,
            headers: { ...headers, "content-range": `bytes */${file.size}` }
        });
    }
    // A range for a different file than the one the TV began is the whole file.
    const ifRange = request.headers.get("if-range");
    const partial = range && (!ifRange || ifRange === etag) ? range : null;
    const start = partial?.from ?? 0;
    const end = partial?.to ?? file.size - 1;
    const body = Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream;
    return new Response(body, {
        status: partial ? 206 : 200,
        headers: {
            ...headers,
            "content-length": String(end - start + 1),
            ...(partial ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {})
        }
    });
}
