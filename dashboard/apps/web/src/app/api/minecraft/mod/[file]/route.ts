/**
 * The login mod's jar, for a Minecraft server's image to download.
 *
 * Public: the server's image fetches it before anything that could present a
 * credential has started, and the jar holds nothing but the mod's own code.
 * Only the files the dashboard image was built with are served, by exact name.
 *
 * The image asks twice on every boot: HEAD, for the file's name and date, then GET
 * with `If-Modified-Since`. `Last-Modified` is what makes an update reach a
 * server - a newer build of the dashboard answers with the newer jar under the
 * same name - and any answer but a success ends the server's boot, which is why a
 * jar missing from the image is logged as the fault it is.
 */

import path from "node:path";
import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { MOD_FILES } from "@/lib/apps/minecraft/polaris-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the image puts the builds. Overridable for a development checkout that
 *  built them somewhere else. */
const MOD_DIR = process.env.POLARIS_MINECRAFT_MODS_DIR || "/app/minecraft-mods";

type Params = { params: Promise<{ file: string }> };

/** The jar a request names, or null when there is none to serve. */
async function jarFor(
    file: string
): Promise<{ location: string; size: number; modified: number } | null> {
    if (!MOD_FILES.includes(file)) return null;
    const location = path.join(MOD_DIR, file);
    const info = await stat(location).catch(() => null);
    if (!info?.isFile()) {
        console.error(
            `[minecraft-mod] ${file} is not in ${MOD_DIR}; this image was built without it`
        );
        return null;
    }
    // HTTP dates have whole seconds, so compare in whole seconds.
    return { location, size: info.size, modified: Math.floor(info.mtimeMs / 1000) * 1000 };
}

function headersFor(file: string, jar: { size: number; modified: number }): Record<string, string> {
    return {
        "last-modified": new Date(jar.modified).toUTCString(),
        "cache-control": "no-cache",
        "content-type": "application/java-archive",
        "content-length": String(jar.size),
        "content-disposition": `attachment; filename="${file}"`
    };
}

export async function HEAD(_request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    const jar = await jarFor(file);
    if (!jar) return new Response(null, { status: 404 });
    return new Response(null, { headers: headersFor(file, jar) });
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    const jar = await jarFor(file);
    if (!jar) return new Response("Not found", { status: 404 });
    const since = Date.parse(request.headers.get("if-modified-since") ?? "");
    if (!Number.isNaN(since) && since >= jar.modified) {
        return new Response(null, {
            status: 304,
            headers: {
                "last-modified": new Date(jar.modified).toUTCString(),
                "cache-control": "no-cache"
            }
        });
    }
    return new Response(Readable.toWeb(createReadStream(jar.location)) as ReadableStream, {
        headers: headersFor(file, jar)
    });
}
