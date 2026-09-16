/**
 * The login mod's jar, for a Minecraft server's image to download.
 *
 * Public: the server's image fetches it before anything that could present a
 * credential has started, and the jar holds nothing but the mod's own code.
 * Only the files the dashboard image was built with are served, by exact name.
 *
 * The image asks twice on every boot: HEAD, then GET. Neither answer carries a
 * date, on purpose. The image keeps a jar whose file is newer than the date it is
 * given, and the file's date is when that server downloaded it, not when the jar
 * was built - so a server restarted between a build being published and this
 * dashboard being updated to it would hold the older jar through every restart
 * after. With no date the jar is fetched on every boot; it is a few kilobytes, and
 * every boot already needs this dashboard to answer. Any answer but a success
 * ends the server's boot, which is why a jar missing from the image is logged as
 * the fault it is.
 */

import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { modDir, modPath } from "@/lib/apps/minecraft/polaris-mod-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ file: string }> };

/** The jar a request names, or null when there is none to serve. */
async function jarFor(file: string): Promise<{ location: string; size: number } | null> {
    const location = modPath(file);
    if (location === null) return null;
    const info = await stat(location).catch(() => null);
    if (!info?.isFile()) {
        console.error(
            `[minecraft-mod] ${file} is not in ${modDir()}; this image was built without it`
        );
        return null;
    }
    return { location, size: info.size };
}

function headersFor(file: string, jar: { size: number }): Record<string, string> {
    return {
        "cache-control": "no-store",
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

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    const jar = await jarFor(file);
    if (!jar) return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(jar.location)) as ReadableStream, {
        headers: headersFor(file, jar)
    });
}
