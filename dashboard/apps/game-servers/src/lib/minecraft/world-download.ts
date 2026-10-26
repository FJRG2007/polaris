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
 *
 * A world is not in the bundle (`map-store.ts`): it is read from the data
 * volume, downloaded there first if this is the first server on that map, so a
 * container that asks before anybody prepared it waits for it rather than
 * booting into an empty world. The packs are a few kilobytes and stay bundled.
 */

import path from "node:path";
import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { bundledDir, ensureMap, MapUnavailable } from "./map-store";
import { MAP_PACK_FILES, WORLD_FILES, WORLD_MAPS } from "./maps";
import { withinLimit, type DownloadLimit } from "./mod-download";

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

type Archive = { location: string; size: number } | null | "unavailable";

/** A map's pack, as the bundle carries it, or null when there is none. */
async function packFor(file: string): Promise<Archive> {
    if (!MAP_PACK_FILES.includes(file)) return null;
    const location = path.join(bundledDir(), file);
    const info = await stat(location).catch(() => null);
    if (!info?.isFile()) {
        console.error(
            `[minecraft-world] ${file} is not in ${bundledDir()}; this bundle was built without it`
        );
        return null;
    }
    return { location, size: info.size };
}

/** A map's world, downloaded onto this disk first when it is not on it yet. */
async function worldFor(file: string): Promise<Archive> {
    const map = WORLD_MAPS.find((entry) => entry.archive === file);
    if (!map) return null;
    try {
        return { location: await ensureMap(map), size: map.bytes };
    } catch (error) {
        if (error instanceof MapUnavailable) return "unavailable";
        throw error;
    }
}

function headersFor(file: string, size: number): Record<string, string> {
    return {
        "cache-control": "no-store",
        "content-type": "application/zip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${file}"`
    };
}

type Finder = (file: string) => Promise<Archive>;

/** Polaris could not download the world: the container's fetch fails and it
 *  tries again on its next start, by when it may have arrived. */
const unavailable = (body: string | null) =>
    new Response(body, { status: 503, headers: { "retry-after": "60" } });

async function head(file: string, find: Finder): Promise<Response> {
    const archive = await find(file);
    if (archive === "unavailable") return unavailable(null);
    if (!archive) return new Response(null, { status: 404 });
    return new Response(null, { headers: headersFor(file, archive.size) });
}

async function get(
    file: string,
    known: readonly string[],
    find: Finder,
    limit: DownloadLimit
): Promise<Response> {
    if (!known.includes(file)) return new Response("Not found", { status: 404 });
    // Counted before the archive is looked up: looking a world up can download it.
    if (!(await withinLimit(limit))) {
        console.warn(`[minecraft-world] ${file}: download refused, over the ${limit.bucket} limit`);
        return new Response("Too many requests", {
            status: 429,
            headers: { "retry-after": String(Math.ceil(limit.windowMs / 1000)) }
        });
    }
    const archive = await find(file);
    if (archive === "unavailable") return unavailable("Not available yet");
    if (!archive) return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(archive.location)) as ReadableStream, {
        headers: headersFor(file, archive.size)
    });
}

export const worldHead = (file: string) => head(file, worldFor);
export const worldGet = (file: string) => get(file, WORLD_FILES, worldFor, WORLD_LIMIT);
export const packHead = (file: string) => head(file, packFor);
export const packGet = (file: string) => get(file, MAP_PACK_FILES, packFor, PACK_LIMIT);
