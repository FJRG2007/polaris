/**
 * GET /api/tv/update/apk?version=<versionName> - the verified APK, streamed from
 * this instance. Honours a single `Range: bytes=` so an interrupted download on a
 * TV resumes. 409 when the version asked for is no longer the newest (ask
 * /api/tv/update again).
 */

import { Readable } from "node:stream";
import { tvCaller } from "@/lib/tv/auth";
import { createReadStream } from "node:fs";
import { preparedTvApk } from "@/lib/tv/release";
import { rangeOf } from "@/lib/http-range";
import { readerWords } from "@/lib/i18n/reader-words";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const t = await readerWords("api");
    const apk = await preparedTvApk().catch(() => null);
    if (!apk) {
        return Response.json({ error: t("errors.tvUpdateUnavailable") }, { status: 503 });
    }
    const asked = new URL(request.url).searchParams.get("version");
    if (asked !== null && asked !== apk.versionName) {
        return Response.json({ error: t("errors.tvUpdateMoved") }, { status: 409 });
    }
    const etag = `"${apk.sha256}"`;
    const headers: Record<string, string> = {
        "content-type": "application/vnd.android.package-archive",
        "content-disposition": 'attachment; filename="polaris-tv.apk"',
        "accept-ranges": "bytes",
        etag,
        "cache-control": "no-store"
    };
    const range = rangeOf(request.headers.get("range"), apk.size);
    if (range === "unsatisfiable") {
        return new Response(null, {
            status: 416,
            headers: { ...headers, "content-range": `bytes */${apk.size}` }
        });
    }
    // A range for a different file than the one the TV began is the whole file.
    const ifRange = request.headers.get("if-range");
    const partial = range && (!ifRange || ifRange === etag) ? range : null;
    const start = partial?.from ?? 0;
    const end = partial?.to ?? apk.size - 1;
    const body = Readable.toWeb(createReadStream(apk.path, { start, end })) as ReadableStream;
    return new Response(body, {
        status: partial ? 206 : 200,
        headers: {
            ...headers,
            "content-length": String(end - start + 1),
            ...(partial ? { "content-range": `bytes ${start}-${end}/${apk.size}` } : {})
        }
    });
});
