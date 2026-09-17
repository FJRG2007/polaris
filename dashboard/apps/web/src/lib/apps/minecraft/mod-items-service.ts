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
import { isBuildKey, isIconName } from "./items";
import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { dirname, join } from "node:path";
import { listEnvVars } from "@/lib/env-var-service";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { PROJECTS_KEY, SOFTWARE_KEY, VERSION_KEY } from "./join-guard";
import { buildFor, isPluginLoader, loaderForType, parseProjectList, projectSlug } from "./modrinth";

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
    /** Mods whose jar could not be read, by the name on the list. The screen says
     *  so rather than quietly showing a shorter catalogue than the server has. */
    readonly unread: readonly string[];
}

const EMPTY: ServerModItems = { items: [], unread: [] };

/** The version an entry is pinned to, when it is a version at all. */
const VERSION = /^[0-9][0-9.]*$/;

/**
 * Everything the mods on one server add.
 *
 * Reads the list off the install itself rather than taking it from the caller:
 * this downloads files, and what it downloads should be decided by what the
 * server is actually configured to install.
 */
export async function serverModItems(ownerId: string, installedAppId: string): Promise<ServerModItems> {
    const settings = await readSettings(ownerId, installedAppId);
    const loader = loaderForType(settings.software);
    // A plugin server loads no client assets, so there is nothing of this kind to
    // read and no reason to fetch anything.
    if (loader === null || isPluginLoader(loader)) return EMPTY;

    const entries = parseProjectList(settings.projects).slice(0, MAX_PROJECTS);
    if (entries.length === 0) return EMPTY;

    const items: ServerModItem[] = [];
    const unread: string[] = [];
    const until = Date.now() + READ_BUDGET_MS;
    for (const entry of entries) {
        const slug = projectSlug(entry);
        if (slug === null) continue;
        // Out of time is not the same as unreadable, and is not reported as it:
        // what is left is read on the next open, from a cache that is by then one
        // mod shorter.
        if (Date.now() > until) break;
        const read = await catalogFor(entry, slug, loader, settings.version).catch(() => null);
        if (read === null) {
            unread.push(slug);
            continue;
        }
        for (const item of read.items) {
            if (items.length >= MAX_ITEMS) break;
            items.push({ ...item, mod: read.title, build: read.build });
        }
    }
    return { items, unread };
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
    const value = (key: string): string => vars.find((item) => item.key === key)?.value?.trim() ?? "";
    const version = value(VERSION_KEY);
    return {
        software: value(SOFTWARE_KEY),
        // LATEST is a real value here and it is not a version: a server whose
        // release nobody knows is one where every build of a mod is a candidate,
        // which is what passing null means downstream.
        version: VERSION.test(version) ? version : null,
        projects: value(PROJECTS_KEY)
    };
}

const catalogSchema = z.object({
    title: z.string().max(120),
    items: z
        .array(
            z.object({
                id: z.string().max(160),
                label: z.string().max(120),
                icon: z
                    .union([
                        z.object({
                            kind: z.literal("mod"),
                            name: z.string().max(200),
                            width: z.number().int().positive().max(4096),
                            height: z.number().int().positive().max(4096)
                        }),
                        z.object({ kind: z.literal("vanilla"), texture: z.string().max(200) })
                    ])
                    .nullable()
            })
        )
        .max(MAX_ITEMS)
});

interface BuildCatalog {
    readonly build: string;
    readonly title: string;
    readonly items: readonly modItems.ModItem[];
}

/** Builds already being read, so two tabs opening the picker at the same moment
 *  fetch one jar between them rather than one each. */
const reading = new Map<string, Promise<BuildCatalog | null>>();

/**
 * What one entry on the list adds, from the cache or from the jar.
 *
 * Throws only when the entry could not be resolved to a build at all - which is
 * the case the screen reports. A build that resolves and turns out to add no
 * items is an empty catalogue, and that is an ordinary answer: half the mods on a
 * normal server are libraries, data packs, or changes to how the game behaves.
 */
async function catalogFor(
    entry: string,
    slug: string,
    loader: string,
    version: string | null
): Promise<BuildCatalog> {
    const build = await buildFor(entry, loader, version);
    if (build === null) throw new Error(`No build of ${slug} to read`);

    const kept = await readCatalog(build.sha1);
    if (kept !== null) return { build: build.sha1, title: kept.title, items: kept.items };

    const key = build.sha1;
    const inFlight = reading.get(key) ?? readBuild(build.sha1, build.url, slug).finally(() => reading.delete(key));
    reading.set(key, inFlight);
    const read = await inFlight;
    if (read === null) throw new Error(`Could not read ${build.filename}`);
    return read;
}

/** The catalogue kept for one build, or null when there is not one. */
async function readCatalog(build: string): Promise<{ title: string; items: modItems.ModItem[] } | null> {
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
async function readBuild(sha1: string, url: string, slug: string): Promise<BuildCatalog | null> {
    let bytes: Uint8Array;
    try {
        const answer = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!answer.ok) return null;
        const length = Number(answer.headers.get("content-length") ?? "0");
        if (length > MAX_JAR_BYTES) return null;
        const body = await answer.arrayBuffer();
        if (body.byteLength === 0 || body.byteLength > MAX_JAR_BYTES) return null;
        bytes = new Uint8Array(body);
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
                const entry = zip.files[path];
                if (!entry || entry.dir || spent > MAX_READ_BYTES) return null;
                const body = await entry.async("uint8array");
                spent += body.byteLength;
                return body;
            }
        });
    } catch {
        // Not a jar, or one this cannot open. One mod without a picture list.
        return null;
    }

    const catalog = { title: slug, items: read.items };
    await keep(sha1, catalog, read.icons);
    return { build: sha1, title: catalog.title, items: catalog.items };
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
