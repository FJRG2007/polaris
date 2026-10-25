/**
 * Answering for one of Polaris's jars: the file, its headers, and how often one
 * address may take it.
 *
 * The image asks twice on every boot: HEAD, then GET. Neither answer carries a
 * date, on purpose. The image keeps a jar whose file is newer than the date it is
 * given, and the file's date is when that server downloaded it, not when the jar
 * was built - so a server restarted between a build being published and this
 * dashboard being updated to it would hold the older jar through every restart
 * after. With no date the jar is fetched on every boot. Any answer but a success
 * ends the server's boot, which is why a jar missing from the image is logged as
 * the fault it is.
 */

import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { host } from "@polaris/app-host";
import { createReadStream } from "node:fs";
import { modDir, publicModPath } from "./polaris-mod-files";

const { rateLimit } = host.rateLimitService;
const { clientIp } = host.requestContext;

/** The jar a request names, or null when there is none to serve. */
async function jarFor(file: string): Promise<{ location: string; size: number } | null> {
    const location = publicModPath(file);
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

/** How many downloads one address may make in the window, and how many everybody
 *  together may - the cap that holds however many addresses an attack uses. */
export interface DownloadLimit {
    readonly bucket: string;
    readonly perAddress: number;
    readonly overall: number;
    readonly windowMs: number;
}

/** Whether this download fits under the limit. HEAD is not counted: it sends no
 *  file. */
export async function withinLimit(limit: DownloadLimit): Promise<boolean> {
    const address = (await clientIp()) ?? "unknown";
    const mine = await rateLimit(`${limit.bucket}:${address}`, limit.perAddress, limit.windowMs);
    if (!mine.ok) return false;
    const everybody = await rateLimit(`${limit.bucket}:all`, limit.overall, limit.windowMs);
    return everybody.ok;
}

export async function jarHead(file: string): Promise<Response> {
    const jar = await jarFor(file);
    if (!jar) return new Response(null, { status: 404 });
    return new Response(null, { headers: headersFor(file, jar) });
}

export async function jarGet(file: string, limit: DownloadLimit): Promise<Response> {
    const jar = await jarFor(file);
    if (!jar) return new Response("Not found", { status: 404 });
    if (!(await withinLimit(limit))) {
        console.warn(`[minecraft-mod] ${file}: download refused, over the ${limit.bucket} limit`);
        return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(Math.ceil(limit.windowMs / 1000)) }
        });
    }
    return new Response(Readable.toWeb(createReadStream(jar.location)) as ReadableStream, {
        headers: headersFor(file, jar)
    });
}
