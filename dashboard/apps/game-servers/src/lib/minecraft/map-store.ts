/**
 * The map archives, kept on this instance's disk only once a server needs one.
 *
 * A world is tens of megabytes, and most instances never build a server on a
 * given map - so none of them travels in the Game servers bundle. Each is
 * published by CI as an artifact of its own in the dashboard's package
 * (`docker/app-bundles.sh worlds`), and fetched from there the first time a
 * server is created or reset onto it, by the sha256 its catalog entry in
 * `maps.ts` names: that hash is the blob's digest, and a download that hashes to
 * anything else is thrown away. After that it is read from the data volume.
 *
 * - A bundle built before the worlds left it still carries them, and those are
 *   used as they are rather than downloaded again.
 * - A download is written to a `.part` file beside the archive and renamed over
 *   it only once its size and hash are right, so the archive is either whole or
 *   absent. A download that was cut off resumes from the `.part` with a range
 *   request, and is retried a few times before it is reported.
 * - One download per map at a time, and only a couple at once in all, so a
 *   burst of creations cannot take the instance's bandwidth.
 *
 * Server-only.
 */

import path from "node:path";
import type { WorldMap } from "./maps";
import type { ReadableStream as WebStream } from "node:stream/web";
import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";

/** Two at once: enough that a second creation is not queued behind a long one. */
const MAX_PARALLEL = 2;
const ATTEMPTS = 3;
/** Per attempt. The largest world is under 30 MB. */
const ATTEMPT_TIMEOUT_MS = 10 * 60_000;

/** Why a map could not be had, as a code the screen words. */
export type MapFailure = "unreachable" | "notPublished" | "corrupt" | "noSpace" | "failed";

export type MapDownload =
    | { readonly state: "ready" }
    | { readonly state: "downloading"; readonly received: number; readonly total: number }
    | { readonly state: "failed"; readonly reason: MapFailure };

export class MapUnavailable extends Error {
    constructor(readonly reason: MapFailure, options?: ErrorOptions) {
        super(`map unavailable: ${reason}`, options);
    }
}

type Entry = { promise: Promise<string>; received: number; total: number };
type State = {
    running: Map<string, Entry>;
    failed: Map<string, MapFailure>;
    active: number;
    queue: (() => void)[];
};

const state: State = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.minecraft.map-store")
] ??= { running: new Map(), failed: new Map(), active: 0, queue: [] }) as State;

/** Where the bundle carries archives: beside its server half, as with the jars.
 *  Since the worlds left the bundle only the packs are there, but a bundle from
 *  before that still has every world. Overridable for a checkout and tests. */
export function bundledDir(): string {
    return (
        process.env.POLARIS_MINECRAFT_WORLDS_DIR ||
        path.join(__dirname, "..", "assets", "minecraft-worlds")
    );
}

/** Where downloaded worlds are kept: on the data volume, which survives updates. */
export function mapCacheDir(): string {
    return (
        process.env.POLARIS_MINECRAFT_MAP_CACHE_DIR ||
        path.join(loadEnv().POLARIS_DATA_DIR, "minecraft-maps")
    );
}

/** The cached copy of one map, named by its hash so a reissued map is a new file. */
export function cachedPath(map: Pick<WorldMap, "id" | "sha256">): string {
    return path.join(mapCacheDir(), `${map.id}-${map.sha256}.zip`);
}

async function sized(location: string, bytes: number): Promise<boolean> {
    const info = await stat(location).catch(() => null);
    return Boolean(info?.isFile() && info.size === bytes);
}

/** The archive on disk for this map - the bundle's, else the cached one - or
 *  null when it has not been downloaded. A file of the wrong size is not it. */
export async function mapArchivePath(map: WorldMap): Promise<string | null> {
    const bundled = path.join(bundledDir(), map.archive);
    if (await sized(bundled, map.bytes)) return bundled;
    const cached = cachedPath(map);
    return (await sized(cached, map.bytes)) ? cached : null;
}

/** Registry host and repository: the one the image's bundles came from, else
 *  the image's own (the same rule as `lib/app-bundles/store.ts`). */
export function mapRegistry(): { host: string; repository: string } {
    let location = "";
    try {
        const index = JSON.parse(
            readFileSync(
                path.join(process.env.POLARIS_APP_BUNDLES_DIR || "/app/app-bundles", "index.json"),
                "utf8"
            )
        ) as { registry?: unknown };
        if (typeof index.registry === "string") location = index.registry;
    } catch {
        // No index: a dashboard built without bundles still knows its image.
    }
    const [host, ...rest] = (location || loadEnv().POLARIS_WEB_IMAGE)
        .replace(/:[^/]*$/, "")
        .split("/");
    if (!host || rest.length === 0) throw new MapUnavailable("unreachable");
    return { host, repository: rest.join("/") };
}

async function pullToken(host: string, repository: string, signal: AbortSignal) {
    const scope = encodeURIComponent(`repository:${repository}:pull`);
    const response = await fetch(
        `https://${host}/token?service=${encodeURIComponent(host)}&scope=${scope}`,
        { signal }
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    return typeof body?.token === "string" ? body.token : null;
}

async function hashOf(location: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(location), hash);
    return hash.digest("hex");
}

function failureOf(error: unknown): MapFailure {
    if (error instanceof MapUnavailable) return error.reason;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") return "noSpace";
    return "unreachable";
}

/** One attempt: resume the `.part` if there is one, then verify and rename. */
async function attempt(map: WorldMap, entry: Entry): Promise<string> {
    const target = cachedPath(map);
    const part = `${target}.part`;
    await mkdir(path.dirname(target), { recursive: true });
    let from = (await stat(part).catch(() => null))?.size ?? 0;
    if (from > map.bytes) {
        await rm(part, { force: true });
        from = 0;
    }
    if (from < map.bytes) {
        const { host, repository } = mapRegistry();
        const signal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
        const token = await pullToken(host, repository, signal);
        const response = await fetch(
            `https://${host}/v2/${repository}/blobs/sha256:${map.sha256}`,
            {
                headers: {
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                    ...(from > 0 ? { range: `bytes=${from}-` } : {})
                },
                signal
            }
        );
        if (response.status === 404 || response.status === 401 || response.status === 403)
            throw new MapUnavailable("notPublished");
        // A server that ignored the range sends the whole file: start over.
        if (response.status === 200) from = 0;
        else if (response.status !== 206) throw new MapUnavailable("unreachable");
        if (!response.body) throw new MapUnavailable("unreachable");
        entry.received = from;
        const limit = map.bytes;
        const count = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                entry.received += chunk.length;
                // Longer than the archive it was asked for is not that archive.
                if (entry.received > limit) done(new MapUnavailable("corrupt"));
                else done(null, chunk);
            }
        });
        await pipeline(
            Readable.fromWeb(response.body as WebStream),
            count,
            createWriteStream(part, { flags: from > 0 ? "a" : "w" })
        );
    }
    const size = (await stat(part)).size;
    if (size < map.bytes) throw new MapUnavailable("unreachable");
    if (size !== map.bytes || (await hashOf(part)) !== map.sha256) {
        await rm(part, { force: true });
        throw new MapUnavailable("corrupt");
    }
    await rename(part, target);
    return target;
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (state.active >= MAX_PARALLEL) await new Promise<void>((go) => state.queue.push(go));
    state.active++;
    try {
        return await work();
    } finally {
        state.active--;
        state.queue.shift()?.();
    }
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function download(map: WorldMap, entry: Entry): Promise<string> {
    let last: unknown;
    for (let tries = 0; tries < ATTEMPTS; tries++) {
        if (tries > 0) await pause(1000 * 3 ** (tries - 1));
        try {
            return await attempt(map, entry);
        } catch (error) {
            last = error;
            const reason = failureOf(error);
            // Only a dropped connection is worth asking again for: a world that is
            // not published, that hashes wrong or that there is no room for would
            // answer the same.
            if (reason !== "unreachable") break;
        }
    }
    throw last instanceof MapUnavailable ? last : new MapUnavailable(failureOf(last), { cause: last });
}

/** The download of this map, started unless one already is. Registered before
 *  anything is awaited, so two callers in the same tick share it. */
function start(map: WorldMap): Entry {
    const running = state.running.get(map.id);
    if (running) return running;
    const entry: Entry = { promise: Promise.resolve(""), received: 0, total: map.bytes };
    entry.promise = (async () => (await mapArchivePath(map)) ?? slot(() => download(map, entry)))()
        .then(async (location) => {
            state.failed.delete(map.id);
            await dropSuperseded(map);
            return location;
        })
        .catch((error: unknown) => {
            const reason = failureOf(error);
            state.failed.set(map.id, reason);
            console.error(`[minecraft-map] ${map.archive} could not be downloaded: ${reason}`, error);
            throw error instanceof MapUnavailable ? error : new MapUnavailable(reason);
        })
        .finally(() => state.running.delete(map.id));
    state.running.set(map.id, entry);
    return entry;
}

/** A reissued map is a new hash and so a new file: the old one is nobody's. */
async function dropSuperseded(map: WorldMap): Promise<void> {
    const keep = path.basename(cachedPath(map));
    const names = await readdir(mapCacheDir()).catch(() => [] as string[]);
    for (const name of names) {
        // Only this map's: another map's id can start with this one's.
        const hash = name.startsWith(`${map.id}-`) ? name.slice(map.id.length + 1) : "";
        if (name !== keep && /^[a-f0-9]{64}\.zip(\.part)?$/.test(hash))
            await rm(path.join(mapCacheDir(), name), { force: true }).catch(() => undefined);
    }
}

/**
 * The archive for this map, downloading it first if it is not on disk yet. One
 * download per map however many ask for it at once.
 */
export async function ensureMap(map: WorldMap): Promise<string> {
    return (await mapArchivePath(map)) ?? start(map).promise;
}

/**
 * Where this map stands, starting its download when it is not on disk. What a
 * screen asks, again and again, while it shows the progress. A failure is
 * reported once; asking after it is a retry.
 */
export async function prepareMap(map: WorldMap): Promise<MapDownload> {
    const running = state.running.get(map.id);
    if (running) return { state: "downloading", received: running.received, total: running.total };
    if (await mapArchivePath(map)) return { state: "ready" };
    const failed = state.failed.get(map.id);
    if (failed) {
        state.failed.delete(map.id);
        return { state: "failed", reason: failed };
    }
    const entry = start(map);
    entry.promise.catch(() => undefined);
    return { state: "downloading", received: entry.received, total: entry.total };
}

/** Start a map's download without waiting for it, so it is likely on disk by
 *  the time the server's container asks. */
export function warmMap(map: WorldMap): void {
    ensureMap(map).catch(() => undefined);
}

/** Forget every download, for a test. */
export function resetMapStore(): void {
    state.running.clear();
    state.failed.clear();
    state.active = 0;
    state.queue = [];
}
