/**
 * `/api/translate/models/<pair>/<file>`: GET answers one file of a Firefox
 * Translations model for the local engine, from Polaris's own storage -
 * downloaded there from the pinned mirror the first time it is asked for. The
 * bytes never change for a name at a revision, so the answer is cached for a
 * year. Same caller and rate rules as `/api/translate`.
 */

import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { caller } from "../../../../../../lib/route";
import { translateT } from "../../../../../../lib/i18n";
import { ensureModelFile } from "../../../../../../lib/local-models";
import { modelFileParams } from "../../../../../../model/local-models";

export async function GET(
    _request: Request,
    context: { params: Promise<{ pair: string; file: string }> }
): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const t = await translateT();
    const params = modelFileParams.safeParse(await context.params);
    if (!params.success) {
        return Response.json({ error: "unknown", message: t("local.unknownModel") }, { status: 404 });
    }
    const { pair, file } = params.data;
    let location: string;
    try {
        location = await ensureModelFile(pair, file);
    } catch (caught) {
        console.error("[translate] model download failed", pair, file.name, caught);
        return Response.json(
            { error: "unreachable", message: t("local.downloadFailed") },
            { status: 502, headers: { "retry-after": "60" } }
        );
    }
    const stream = Readable.toWeb(createReadStream(location)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
        headers: {
            "content-type": "application/octet-stream",
            "content-length": String(file.size),
            etag: `"${file.sha256}"`,
            "cache-control": "private, max-age=31536000, immutable"
        }
    });
}
