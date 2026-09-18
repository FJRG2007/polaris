/**
 * The items this server's mods add, kept between visits.
 *
 * `mod-items` reads one jar; this is everything around that - which jars, when
 * they are fetched, and where what comes out of them is kept. All of it on
 * demand: the first time somebody opens the item picker on a modded server. A
 * server with no mods, or one running plugins rather than mods, does no work at
 * all and reaches nobody, which is what keeps this off every deployment that was
 * running happily before it existed.
 *
 * Kept per build rather than per server, under the jar's own SHA-1. A build that
 * has not changed is never downloaded twice - not on the next visit, not on the
 * next restart, and not for the second server running the same mod. A list that
 * moves a mod to a newer build simply reads a key that is not there yet, and the
 * old one stays until the folder is cleared, which costs a folder rather than a
 * wrong answer.
 *
 * What is kept is small and is not the jar: the ids and labels as JSON, and the
 * distinct textures as PNGs. SecurityCraft's 5 MB jar leaves 42 KiB behind.
 *
 * Server-only.
 */

import { z } from "zod";
import JSZip from "jszip";
import { prisma } from "@polaris/db";
import * as modItems from "./mod-items";
import { isBuildKey, isIconName, modItemSchema } from "./items";
import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { PROJECTS_KEY, SOFTWARE_KEY, VERSION_KEY } from "./join-guard";
import {
    buildFor,
    isGameVersion,
    isPluginLoader,
    loaderForType,
    parseProjectList,
    projectSlug
} from "./modrinth";
import { host } from "@polaris/app-host";

const { listEnvVars } = host.envVarService;

/** How many entries on a list are read. Past this is a modpack, and a modpack is
 *  not something to resolve one jar at a time while somebody waits. */
const MAX_PROJECTS = 24;

/** What the whole picker is allowed to carry. Rechiseled alone is 3739 items, so
 *  this is a few of those rather than a number anybody normal reaches. */
const MAX_ITEMS = 12000;

/** A jar bigger than this is not read. Nothing that adds items comes close - the
 *  largest on the server this was built for is 12 MB. */
const MAX_JAR_BYTES = 96 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * How much of a jar is read after it is opened.
 *
 * A zip says what it holds in its directory and nothing forces that to be honest:
 * one entry can claim a kilobyte and expand to a gigabyte. Nothing is read whole
 * before this is checked against what has already been read, so a jar that is a
 * bomb costs this much and then stops, rather than the process.
 *
 * Generous against real mods - the whole of Rechiseled's assets are a few
 * megabytes - and the reader treats a refused read as a missing file, which is
 * one item without a picture.
 */
const MAX_READ_BYTES = 64 * 1024 * 1024;

/**
 * How long one request spends fetching jars it has never seen.
 *
 * Everything already read is answered from disk and costs nothing, so this only
 * bounds the first visit on a server with a long list. What is not reached in
 * time is simply not read this time: the ones that were are kept, and the next
 * time the picker is opened it starts from those and continues.
 *
 * A ceiling rather than a place to stop starting work: a download begun with a
 * second left is given that second and not the whole `DOWNLOAD_TIMEOUT_MS`, so
 * the answer cannot run past this and be cut by an edge timeout - which would
 * hand the panel nothing at all in place of the list already assembled.
 */
const READ_BUDGET_MS = 45_000;

/** One modded item, as the panel receives it. */
export interface ServerModItem extends modItems.ModItem {
    /** Which mod it came from, for the tile that says so. */
    readonly mod: string;
    /** The build its picture is kept under, so the panel can address it. */
    readonly build: string;
}

export interface ServerModItems {
    readonly items: readonly ServerModItem[];
    /**
     * Whether this is the whole list.
     *
     * False when the budget ran out with entries still to read. The panel needs
     * to be told, because what it does with an answer is keep it: a partial one
     * held for five minutes is a server whose remaining mods do not appear until
     * somebody reloads the tab, and the reading that would have finished them is
     * one the cache never asks for.
     */
    readonly complete: boolean;
    /** Mods whose jar could not be read, by the name on the list. The screen says
     *  so rather than quietly showing a shorter catalogue than the server has. */
    readonly unread: readonly string[];
    /** Mods past `MAX_PROJECTS` on the list, which are not read at all. Named so
     *  the screen can say the catalogue stops short of the server's. */
    readonly skipped: readonly string[];
}

const EMPTY: ServerModItems = { items: [], unread: [], skipped: [], complete: true };

/**
 * Everything the mods on one server add.
 *
 * Reads the list off the install itself rather than taking it from the caller:
 * this downloads files, and what it downloads should be decided by what the
 * server is actually configured to install.
 */
export async function serverModItems(
    ownerId: string,
    installedAppId: string
): Promise<ServerModItems> {
    const settings = await readSettings(ownerId, installedAppId);
    const loader = loaderForType(settings.software);
    // A plugin server loads no client assets, so there is nothing of this kind to
    // read and no reason to fetch anything.
    if (loader === null || isPluginLoader(loader)) return EMPTY;

    // Entries with no Modrinth slug are files placed by hand, which have nothing
    // to download, so they are left out before the cap rather than spending it.
    const listed = parseProjectList(settings.projects).flatMap((entry) => {
        const slug = projectSlug(entry);
        return slug === null ? [] : [{ entry, slug }];
    });
    if (listed.length === 0) return EMPTY;
    const entries = listed.slice(0, MAX_PROJECTS);
    const skipped = listed.slice(MAX_PROJECTS).map((item) => item.slug);

    const items: ServerModItem[] = [];
    const taken = new Set<string>();
    const unread: string[] = [];
    const until = Date.now() + READ_BUDGET_MS;
    let complete = true;
    for (const { entry, slug } of entries) {
        // Out of time is not the same as unreadable, and is not reported as it:
        // what is left is read on the next open, from a cache that is by then one
        // mod shorter.
        if (Date.now() >= until) {
            complete = false;
            break;
        }
        const read = await catalogFor(entry, slug, loader, settings.version, until).catch(
            (caught: unknown) => (caught instanceof OutOfTime ? "out of time" : null)
        );
        // A read the clock cut short is not a mod whose jar cannot be read, so it
        // is left for the next open rather than reported as broken.
        if (read === "out of time") {
            complete = false;
            break;
        }
        if (read === null) {
            unread.push(slug);
            continue;
        }
        for (const item of read.items) {
            if (items.length >= MAX_ITEMS) break;
            if (taken.has(item.id)) continue;
            taken.add(item.id);
            items.push({ ...item, mod: read.title, build: read.build });
        }
        // Past the cap the rest of the list is jars downloaded and read for items
        // that are then dropped, so the walk stops here and not just the copy.
        if (items.length >= MAX_ITEMS) break;
    }
    return { items, unread, skipped, complete };
}

/** One kept picture, or null when nothing was ever kept under that name. */
export async function modItemIcon(build: string, name: string): Promise<Buffer | null> {
    if (!isBuildKey(build) || !isIconName(name)) return null;
    return readFile(join(iconFolder(build), `${name}.png`)).catch(() => null);
}

/** What a server is, as the three values that decide what it installs. */
async function readSettings(
    ownerId: string,
    installedAppId: string
): Promise<{ software: string; version: string | null; projects: string }> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    if (!install?.applicationId) return { software: "", version: null, projects: "" };
    const vars = await listEnvVars("application", install.applicationId, ownerId).catch(() => []);
    const value = (key: string): string =>
        vars.find((item) => item.key === key)?.value?.trim() ?? "";
    const version = value(VERSION_KEY);
    return {
        software: value(SOFTWARE_KEY),
        // LATEST is a real value here and it is not a version: a server whose
        // release nobody knows is one where every build of a mod is a candidate,
        // which is what passing null means downstream.
        version: isGameVersion(version) ? version : null,
        projects: value(PROJECTS_KEY)
    };
}

const catalogSchema = z.object({
    title: z.string().max(120),
    items: z.array(modItemSchema).max(MAX_ITEMS)
});

interface BuildCatalog {
    readonly build: string;
    readonly title: string;
    readonly items: readonly modItems.ModItem[];
}

/**
 * Builds already being read, so two tabs opening the picker at the same moment
 * fetch one jar between them rather than one each.
 *
 * Each carries the deadline it was started under, because that is what decides
 * whether its answer is one a joiner may take: a read that ended because the
 * first caller's clock ran out says nothing about the jar, and a second caller
 * who still has time should do it rather than inherit it.
 */
const reading = new Map<string, { until: number; work: Promise<BuildCatalog | null> }>();

/** Thrown when the budget ran out rather than the jar being unreadable. The two
 *  are different sentences on the screen: one names a mod as broken, the other
 *  is a list that finishes assembling on the next open. */
class OutOfTime extends Error {}

/**
 * What one entry on the list adds, from the cache or from the jar.
 *
 * Throws `OutOfTime` when the clock ended it and an ordinary error when the entry
 * could not be resolved or read - which is the one the screen reports. A build
 * that resolves and turns out to add no items is an empty catalogue, and that is
 * an ordinary answer: half the mods on a normal server are libraries, data packs,
 * or changes to how the game behaves.
 */
async function catalogFor(
    entry: string,
    slug: string,
    loader: string,
    version: string | null,
    until: number
): Promise<BuildCatalog> {
    const build = await beforeDeadline(buildFor(entry, loader, version), until);
    if (build === null) throw new Error(`No build of ${slug} to read`);

    const kept = await readCatalog(build.sha1);
    if (kept !== null) return { build: build.sha1, title: kept.title, items: kept.items };

    const read = await sharedRead(build.sha1, build.url, slug, until);
    if (read === null) {
        if (Date.now() >= until) throw new OutOfTime(`Out of time reading ${build.filename}`);
        throw new Error(`Could not read ${build.filename}`);
    }
    return read;
}

/** One read of one build at a time, joined by anybody asking for the same build -
 *  unless what they would join ended on a deadline earlier than their own, which
 *  is a verdict about a clock rather than about a jar. */
async function sharedRead(
    sha1: string,
    url: string,
    slug: string,
    until: number
): Promise<BuildCatalog | null> {
    const held = reading.get(sha1);
    if (held) {
        const joined = await held.work;
        if (joined !== null || held.until >= until || Date.now() >= until) return joined;
    }
    const work = readBuild(sha1, url, slug, until).finally(() => {
        if (reading.get(sha1)?.work === work) reading.delete(sha1);
    });
    reading.set(sha1, { until, work });
    return work;
}

/** The catalogue kept for one build, or null when there is not one. */
async function readCatalog(
    build: string
): Promise<{ title: string; items: modItems.ModItem[] } | null> {
    try {
        const raw = await readFile(join(buildFolder(build), "catalog.json"), "utf8");
        const parsed = catalogSchema.safeParse(JSON.parse(raw));
        // It is this side's own file, and it is still parsed rather than trusted:
        // a half-written or hand-edited one would otherwise reach a screen.
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * Fetch one jar and keep what it adds.
 *
 * The jar itself is never kept. It is read once, in memory, and what survives is
 * the list and the pictures - about one percent of what was downloaded.
 *
 * The hash is checked against what Modrinth said it would be before any of it is
 * believed, because the hash is also the name the result is filed under: an
 * unverified one would file the wrong mod's items under a key that is then
 * treated as correct forever.
 */
async function readBuild(
    sha1: string,
    url: string,
    slug: string,
    until: number
): Promise<BuildCatalog | null> {
    let bytes: Uint8Array;
    try {
        const left = until - Date.now();
        if (left <= 0) return null;
        const answer = await fetch(url, {
            signal: AbortSignal.timeout(Math.min(DOWNLOAD_TIMEOUT_MS, left))
        });
        if (!answer.ok || answer.body === null) return null;
        const length = Number(answer.headers.get("content-length") ?? "0");
        if (length > MAX_JAR_BYTES) return null;
        const body = await bounded(answer.body, MAX_JAR_BYTES);
        if (body === null || body.byteLength === 0) return null;
        bytes = body;
    } catch {
        return null;
    }
    if (createHash("sha1").update(bytes).digest("hex") !== sha1) return null;

    let read: modItems.JarItems;
    try {
        const zip = await JSZip.loadAsync(bytes);
        let spent = 0;
        read = await modItems.readJarItems({
            paths: Object.keys(zip.files),
            read: async (path: string) => {
                if (Date.now() >= until) throw new Error("Out of time reading the jar");
                const entry = zip.files[path];
                if (!entry || entry.dir) return null;
                const body = await inflated(entry, MAX_READ_BYTES - spent);
                if (body === null) return null;
                spent += body.byteLength;
                return body;
            }
        });
    } catch {
        // Not a jar, or one this cannot open. One mod without a picture list.
        return null;
    }

    // Checked against the schema that reads it back, and the items that do not fit
    // dropped rather than kept: one over-long texture or namespace in a file that
    // is parsed on the way in would make the whole kept catalogue unreadable, and
    // an unreadable one is the jar downloaded again on every single open.
    const catalog = catalogSchema.safeParse({ title: slug, items: read.items });
    const kept = catalog.success
        ? catalog.data
        : {
              title: slug,
              items: read.items.filter((item) => modItemSchema.safeParse(item).success)
          };
    await keep(sha1, kept, read.icons);
    return { build: sha1, title: kept.title, items: kept.items };
}

/** A promise that settles no later than `until`, rejecting when it would not. The
 *  work behind it carries on and is kept by whatever else is waiting on it. */
function beforeDeadline<T>(work: Promise<T>, until: number): Promise<T> {
    const left = until - Date.now();
    if (left <= 0) return Promise.reject(new OutOfTime("Out of time"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OutOfTime("Out of time")), left);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Everything a response carries, as long as it fits in `limit`.
 *
 * `arrayBuffer()` reads whatever is sent, and `content-length` is a claim by the
 * same server that sends the body: absent or understated, the whole download is
 * already in this heap by the time anything compares it against the cap. Counted
 * here instead, and the connection dropped the moment it goes past.
 */
async function bounded(
    body: ReadableStream<Uint8Array>,
    limit: number
): Promise<Uint8Array | null> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let room = true;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limit) {
                room = false;
                break;
            }
            chunks.push(chunk.value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    return room ? concat(chunks, size) : null;
}

/**
 * One zip entry's bytes, as long as they fit in `room`.
 *
 * `async("uint8array")` inflates the entry whole before anything can see how big
 * it turned out, so an entry that claims a kilobyte and expands to a gigabyte is
 * in this heap before the budget is ever looked at. It is streamed instead and
 * dropped the moment it passes what is left, which costs one block rather than
 * the process. A refused read is a missing file to the reader above, which is one
 * item without a picture.
 */
function inflated(entry: JSZip.JSZipObject, room: number): Promise<Uint8Array | null> {
    if (room <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        let settled = false;
        const stop = (value: Uint8Array | null): void => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        // JSZip's own streaming reader, which its bundled typings leave out: the
        // two helpers they do describe both read the whole entry first.
        const stream = (entry as unknown as Streamed).internalStream("uint8array");
        stream
            .on("data", (chunk) => {
                if (settled) return;
                size += chunk.byteLength;
                if (size > room) {
                    stream.pause();
                    stop(null);
                    return;
                }
                chunks.push(chunk);
            })
            .on("error", () => stop(null))
            .on("end", () => stop(concat(chunks, size)))
            .resume();
    });
}

/** A zip entry as something that can be read a block at a time. */
interface Streamed {
    internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
    }
    return all;
}

/**
 * Write one build's catalogue out.
 *
 * The pictures first and the list last, both moved into place rather than written
 * in place: the list being there is what makes a build count as read, so it is
 * the last thing to appear and it never appears half-written. A failure anywhere
 * leaves the build unread rather than partly read, and the next visit does it
 * again.
 */
async function keep(
    build: string,
    catalog: { title: string; items: readonly modItems.ModItem[] },
    icons: ReadonlyMap<string, Uint8Array>
): Promise<void> {
    try {
        await mkdir(iconFolder(build), { recursive: true });
        for (const [name, bytes] of icons) {
            if (!isIconName(name)) continue;
            await place(join(iconFolder(build), `${name}.png`), bytes);
        }
        await place(join(buildFolder(build), "catalog.json"), Buffer.from(JSON.stringify(catalog)));
    } catch {
        // A full disk or a read-only volume is a reason to answer this request
        // from what is already in memory, not to fail it.
    }
}

async function place(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${path}.${process.pid}.part`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, bytes);
    await rename(temporary, path);
}

/** Beside the other borrowed pictures, on Polaris' own disk: a cache belongs next
 *  to the thing it speeds up. */
function buildFolder(build: string): string {
    return join(loadEnv().POLARIS_DATA_DIR, "mod-items", build);
}

function iconFolder(build: string): string {
    return join(buildFolder(build), "icons");
}
