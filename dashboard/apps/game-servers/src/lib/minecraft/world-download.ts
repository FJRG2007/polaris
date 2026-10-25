/**
 * The map archives as this app's bundle carries them, and answering for one.
 *
 * Two audiences, two doors. A world is fetched by a server's container while it
 * is being created, so it is served behind the instance's key (`mod-token`), like
 * the jars: tens of megabytes at an address anybody can fetch is somebody else's
 * bandwidth. A map's resource pack is fetched by every player's game client,
 * which presents no credential at all, so that door is public - and the packs
 * are the map's own textures, small and nothing anybody needs to keep. Both
 * serve only the files `maps.ts` names, and both count downloads per address.
 */

import path from "node:path";
import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { MAP_PACK_FILES, WORLD_FILES } from "./maps";
import { withinLimit, type DownloadLimit } from "./mod-download";

/** Where the bundle carries the archives: beside its server half, as with the
 *  jars. Overridable for a development checkout and for tests. */
export function worldDir(): string {
    return (
        process.env.POLARIS_MINECRAFT_WORLDS_DIR ||
        path.join(__dirname, "..", "assets", "minecraft-worlds")
    );
}

/** A server is created, fails, is fixed and booted again: a few fetches per
 *  address. Overall, a handful of servers created in one sitting. */
export const WORLD_LIMIT: DownloadLimit = {
    bucket: "mc-world-get",
    perAddress: 10,
    overall: 30,
    windowMs: 10 * 60_000
};

/** Every player of a server fetches the pack once and keeps it by its hash, and
 *  many players can share one address. */
export const PACK_LIMIT: DownloadLimit = {
    bucket: "mc-map-pack-get",
    perAddress: 30,
    overall: 300,
    windowMs: 10 * 60_000
};

/** The archive a request names, or null when there is none to serve. */
async function archiveFor(
    file: string,
    known: readonly string[]
): Promise<{ location: string; size: number } | null> {
    if (!known.includes(file)) return null;
    const location = path.join(worldDir(), file);
    const info = await stat(location).catch(() => null);
    if (!info?.isFile()) {
        console.error(
            `[minecraft-world] ${file} is not in ${worldDir()}; this bundle was built without it`
        );
        return null;
    }
    return { location, size: info.size };
}

function headersFor(file: string, size: number): Record<string, string> {
    return {
        "cache-control": "no-store",
        "content-type": "application/zip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${file}"`
    };
}

async function head(file: string, known: readonly string[]): Promise<Response> {
    const archive = await archiveFor(file, known);
    if (!archive) return new Response(null, { status: 404 });
    return new Response(null, { headers: headersFor(file, archive.size) });
}

async function get(
    file: string,
    known: readonly string[],
    limit: DownloadLimit
): Promise<Response> {
    const archive = await archiveFor(file, known);
    if (!archive) return new Response("Not found", { status: 404 });
    if (!(await withinLimit(limit))) {
        console.warn(`[minecraft-world] ${file}: download refused, over the ${limit.bucket} limit`);
        return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(Math.ceil(limit.windowMs / 1000)) }
        });
    }
    return new Response(Readable.toWeb(createReadStream(archive.location)) as ReadableStream, {
        headers: headersFor(file, archive.size)
    });
}

export const worldHead = (file: string) => head(file, WORLD_FILES);
export const worldGet = (file: string) => get(file, WORLD_FILES, WORLD_LIMIT);
export const packHead = (file: string) => head(file, MAP_PACK_FILES);
export const packGet = (file: string) => get(file, MAP_PACK_FILES, PACK_LIMIT);
