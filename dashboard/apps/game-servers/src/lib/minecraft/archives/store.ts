/**
 * Server packs and worlds people bring themselves: received, cleaned, kept, and
 * handed to a server's container.
 *
 * Two ways in, one way through. A file is sent from the browser in pieces, so a
 * pack of several hundred megabytes survives a proxy's request limit and a
 * dropped connection resumes where it stopped; a link is downloaded here, with
 * every hop checked like any address somebody typed. Either way the archive is
 * read by its index, what the server should not receive is left out (`plan.ts`),
 * and the rest is copied into a new archive without being unpacked (`zip.ts`).
 *
 * What is kept is named by its sha256, so the same pack sent twice is one file
 * and a server's `GENERIC_PACK` or `WORLD` says exactly which bytes it runs. The
 * container downloads it from the world path (`world-download.ts`), behind the
 * instance's key; the image extracts it itself. An archive no server names any
 * more is removed by the sweep a day after it was made.
 *
 * Progress lives in this process: a restart in the middle of a send loses it,
 * and the screen sends again. Nothing half-made is ever served.
 *
 * Server-only.
 */

import path from "node:path";
import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import { host } from "@polaris/app-host";
import { loadEnv } from "@polaris/config";
import { pipeline } from "node:stream/promises";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readZipIndex, readZipText, rewriteZip, ZipRefusal, type ZipEntry } from "./zip";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import {
    detectLoader,
    loaderFileEntries,
    planPack,
    planWorld,
    PlanRefusal,
    type ArchiveKind,
    type DetectedLoader,
    type Plan
} from "./plan";
import { WORLD_PATH, type MapAddresses } from "../maps";

const { follow, safeUrl } = host.safeFetch;

/** The largest archive taken. What is written stays under the 4 GiB a plain
 *  ZIP can address, with room for the index. */
export const MAX_ARCHIVE_BYTES = 3 * 1024 ** 3;
/** One piece of a browser upload. Well under any proxy's request limit. */
export const CHUNK_BYTES = 8 * 1024 ** 2;
/** How long an archive nobody uses, or a send nobody finished, is kept. */
const KEEP_UNUSED_MS = 24 * 3_600_000;
/** How long a finished or failed send is remembered for the screen polling it. */
const KEEP_JOB_MS = 60 * 60_000;
/** Sends one person may have going at once. */
const MAX_OPEN_PER_USER = 3;
/** A link's download, start to finish. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Room needed beside an archive: the original and the cleaned copy. */
const SPACE_FACTOR = 2.1;

/** Why an archive could not be taken, as a code the screen words. */
export type ArchiveFailure =
    | "tooLarge"
    | "noSpace"
    | "unreachable"
    | "notFound"
    | "notZip"
    | "encrypted"
    | "method"
    | "tooMany"
    | "unsafePath"
    | "empty"
    | "noContent"
    | "isWorld"
    | "isPack"
    | "ambiguous"
    | "busy"
    | "failed";

export class ArchiveRefusal extends Error {
    constructor(readonly reason: ArchiveFailure) {
        super(`archive refused: ${reason}`);
    }
}

/** What the screen is told about an archive that is ready. */
export interface ArchiveInfo {
    /** Its sha256: what a server is pointed at. */
    readonly id: string;
    readonly kind: ArchiveKind;
    /** The name it was sent under, for people to recognise it by. */
    readonly name: string;
    readonly bytes: number;
    readonly loader: DetectedLoader | null;
    readonly mods: number;
    readonly plugins: number;
    readonly levelName: string | null;
    readonly datapacks: number;
    /** What was left out, by its top-level name. */
    readonly dropped: readonly string[];
    readonly createdAt: string;
}

export type ArchiveJobView =
    | { readonly state: "receiving"; readonly received: number; readonly total: number }
    | { readonly state: "downloading"; readonly received: number; readonly total: number | null }
    | { readonly state: "processing" }
    | { readonly state: "ready"; readonly archive: ArchiveInfo }
    | { readonly state: "failed"; readonly reason: ArchiveFailure };

interface Job {
    readonly id: string;
    readonly userId: string;
    readonly kind: ArchiveKind;
    readonly name: string;
    total: number | null;
    received: number;
    state: ArchiveJobView["state"];
    archive?: ArchiveInfo;
    reason?: ArchiveFailure;
    at: number;
}

const jobs: Map<string, Job> = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.minecraft.archive-jobs")
] ??= new Map<string, Job>()) as Map<string, Job>;

export function archiveDir(): string {
    return (
        process.env.POLARIS_MINECRAFT_ARCHIVE_DIR ||
        path.join(loadEnv().POLARIS_DATA_DIR, "minecraft-archives")
    );
}

const incomingDir = () => path.join(archiveDir(), "incoming");
const partPath = (id: string) => path.join(incomingDir(), `${id}.part`);

const SHA = /^[a-f0-9]{64}$/;
const FILE = /^polaris-(pack|world)-([a-f0-9]{64})\.zip$/;

export const isArchiveId = (value: string) => SHA.test(value);
export const archivePath = (id: string) => path.join(archiveDir(), `${id}.zip`);
const metaPath = (id: string) => path.join(archiveDir(), `${id}.json`);

/** The file name a container downloads an archive under. */
export function archiveFileName(kind: ArchiveKind, id: string): string {
    return `polaris-${kind}-${id}.zip`;
}

/** The archive a served file name names, or null for any other name. */
export function archiveOfFile(file: string): { kind: ArchiveKind; id: string } | null {
    const match = FILE.exec(file);
    return match ? { kind: match[1] as ArchiveKind, id: match[2]! } : null;
}

/** Where a server's container downloads this archive. */
export function archiveUrl(addresses: MapAddresses, kind: ArchiveKind, id: string): string {
    return `${addresses.world.replace(/\/+$/, "")}${WORLD_PATH}/${encodeURIComponent(addresses.key)}/${archiveFileName(kind, id)}`;
}

/** The archive a `GENERIC_PACK` or `WORLD` value Polaris wrote fetches, or null. */
export function archiveOfUrl(url: string | undefined | null): { kind: ArchiveKind; id: string } | null {
    try {
        const parsed = new URL((url ?? "").trim());
        if (!parsed.pathname.startsWith(`${WORLD_PATH}/`)) return null;
        return archiveOfFile(parsed.pathname.split("/").pop() ?? "");
    } catch {
        return null;
    }
}

function failureOf(error: unknown): ArchiveFailure {
    if (error instanceof ArchiveRefusal) return error.reason;
    if (error instanceof ZipRefusal) return error.reason;
    if (error instanceof PlanRefusal) return error.reason;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOSPC" || code === "EDQUOT") return "noSpace";
    return "failed";
}

function view(job: Job): ArchiveJobView {
    switch (job.state) {
        case "receiving":
            return { state: "receiving", received: job.received, total: job.total ?? 0 };
        case "downloading":
            return { state: "downloading", received: job.received, total: job.total };
        case "processing":
            return { state: "processing" };
        case "ready":
            return { state: "ready", archive: job.archive! };
        default:
            return { state: "failed", reason: job.reason ?? "failed" };
    }
}

function forget(): void {
    const now = Date.now();
    for (const [id, job] of jobs) {
        const done = job.state === "ready" || job.state === "failed";
        if (done && now - job.at > KEEP_JOB_MS) jobs.delete(id);
    }
}

function ownJob(userId: string, id: string): Job {
    const job = jobs.get(id);
    // Somebody else's send is the same answer as none: nothing about it is theirs.
    if (!job || job.userId !== userId) throw new ArchiveRefusal("notFound");
    return job;
}

/** The disk has room for an archive this size and the cleaned copy beside it. */
async function assertRoom(bytes: number): Promise<void> {
    await mkdir(incomingDir(), { recursive: true });
    const info = await statfs(archiveDir()).catch(() => null);
    if (info && info.bavail * info.bsize < bytes * SPACE_FACTOR) throw new ArchiveRefusal("noSpace");
}

function openJob(userId: string, kind: ArchiveKind, name: string, total: number | null): Job {
    forget();
    const open = [...jobs.values()].filter(
        (job) =>
            job.userId === userId &&
            (job.state === "receiving" || job.state === "downloading" || job.state === "processing")
    );
    if (open.length >= MAX_OPEN_PER_USER) throw new ArchiveRefusal("busy");
    const job: Job = {
        id: randomUUID(),
        userId,
        kind,
        name: cleanName(name),
        total,
        received: 0,
        state: "receiving",
        at: Date.now()
    };
    jobs.set(job.id, job);
    return job;
}

/** A file name as it may be shown: no path, no control characters, bounded. */
export function cleanName(name: string): string {
    const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
    return (cleaned.length > 0 ? cleaned : "archive.zip").slice(0, 120);
}

/** Starts a browser upload of `total` bytes. Returns the id the pieces carry. */
export async function startUpload(
    userId: string,
    input: { kind: ArchiveKind; name: string; total: number }
): Promise<string> {
    if (!Number.isSafeInteger(input.total) || input.total <= 0) throw new ArchiveRefusal("empty");
    if (input.total > MAX_ARCHIVE_BYTES) throw new ArchiveRefusal("tooLarge");
    await assertRoom(input.total);
    const job = openJob(userId, input.kind, input.name, input.total);
    await writeFile(partPath(job.id), new Uint8Array(0), { flag: "w" });
    return job.id;
}

/**
 * One piece, at the offset it claims. A piece for anywhere but the end of what
 * arrived is refused with what did arrive, so the sender resumes from there
 * instead of leaving a hole or writing twice.
 */
export async function appendPiece(
    userId: string,
    id: string,
    offset: number,
    bytes: Uint8Array
): Promise<{ received: number }> {
    const job = ownJob(userId, id);
    if (job.state !== "receiving") throw new ArchiveRefusal("notFound");
    if (offset !== job.received) return { received: job.received };
    if (bytes.byteLength === 0 || bytes.byteLength > CHUNK_BYTES) throw new ArchiveRefusal("failed");
    if (job.received + bytes.byteLength > (job.total ?? 0)) throw new ArchiveRefusal("tooLarge");
    // Counted before the write lands, so a second piece for the same offset sent
    // while this one is being written is answered "already have it".
    job.received += bytes.byteLength;
    job.at = Date.now();
    try {
        await appendFile(partPath(id), bytes);
    } catch (error) {
        job.received -= bytes.byteLength;
        throw error;
    }
    return { received: job.received };
}

/** Every piece is in: the archive is read and cleaned in the background. */
export function finishUpload(userId: string, id: string): ArchiveJobView {
    const job = ownJob(userId, id);
    if (job.state !== "receiving") return view(job);
    if (job.received !== job.total) throw new ArchiveRefusal("failed");
    job.state = "processing";
    void processJob(job);
    return view(job);
}

/** Where a send stands, for the screen polling it. */
export function jobStatus(userId: string, id: string): ArchiveJobView {
    return view(ownJob(userId, id));
}

/** Stops a send and throws away what arrived. */
export async function cancelJob(userId: string, id: string): Promise<void> {
    const job = ownJob(userId, id);
    jobs.delete(job.id);
    await rm(partPath(job.id), { force: true }).catch(() => undefined);
}

/**
 * Downloads an archive from a link, in the background. Only `https`, every hop
 * checked against private addresses, and never past the size limit whatever the
 * server claims.
 */
export async function importLink(
    userId: string,
    input: { kind: ArchiveKind; url: string }
): Promise<string> {
    const url = await safeUrl(input.url.trim());
    if (!url || url.protocol !== "https:") throw new ArchiveRefusal("unreachable");
    await assertRoom(256 * 1024 ** 2);
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "") || url.hostname;
    const job = openJob(userId, input.kind, name, null);
    job.state = "downloading";
    void downloadJob(job, url);
    return job.id;
}

async function downloadJob(job: Job, url: URL): Promise<void> {
    const part = partPath(job.id);
    try {
        const response = await follow(
            url,
            "application/zip,application/octet-stream;q=0.9,*/*;q=0.5",
            undefined,
            DOWNLOAD_TIMEOUT_MS
        );
        if (!response) throw new ArchiveRefusal("unreachable");
        if (response.status === 404 || response.status === 410) throw new ArchiveRefusal("notFound");
        if (!response.ok || !response.body) throw new ArchiveRefusal("unreachable");
        const claimed = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(claimed) && claimed > MAX_ARCHIVE_BYTES) throw new ArchiveRefusal("tooLarge");
        if (Number.isFinite(claimed) && claimed > 0) {
            job.total = claimed;
            await assertRoom(claimed);
        }
        const counted = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
        counted.on("data", (chunk: Buffer) => {
            job.received += chunk.length;
            job.at = Date.now();
            if (job.received > MAX_ARCHIVE_BYTES) counted.destroy(new ArchiveRefusal("tooLarge"));
        });
        await mkdir(incomingDir(), { recursive: true });
        await pipeline(counted, createWriteStream(part, { flags: "w" }));
        job.state = "processing";
        await processJob(job);
    } catch (error) {
        job.state = "failed";
        job.reason = failureOf(error);
        job.at = Date.now();
        if (job.reason === "failed") console.error("[minecraft-archive] download failed:", error);
        await rm(part, { force: true }).catch(() => undefined);
    }
}

async function hashOf(location: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(location), hash);
    return hash.digest("hex");
}

async function textsFor(location: string, entries: Map<string, ZipEntry>): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    for (const [base, entry] of entries) {
        const text = await readZipText(location, entry);
        if (text !== null) texts.set(base, text);
    }
    return texts;
}

/** Reads, cleans and keeps one received archive. */
export async function processArchive(
    location: string,
    kind: ArchiveKind,
    name: string
): Promise<ArchiveInfo> {
    const entries = await readZipIndex(location);
    const plan: Plan = kind === "pack" ? planPack(entries) : planWorld(entries);
    const loader =
        kind === "pack"
            ? detectLoader(
                  await textsFor(location, loaderFileEntries(entries, plan.root)),
                  entries.map((entry) => entry.name)
              )
            : null;
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const kept = plan.kept.map(({ from, to }) => ({ entry: byName.get(from)!, name: to }));
    const temporary = path.join(incomingDir(), `${randomUUID()}.zip.part`);
    await mkdir(incomingDir(), { recursive: true });
    try {
        const bytes = await rewriteZip(location, temporary, kept);
        const id = await hashOf(temporary);
        const info: ArchiveInfo = {
            id,
            kind,
            name,
            bytes,
            loader,
            mods: plan.mods,
            plugins: plan.plugins,
            levelName: plan.levelName,
            datapacks: plan.datapacks,
            dropped: plan.dropped.slice(0, 40),
            createdAt: new Date().toISOString()
        };
        await rename(temporary, archivePath(id));
        await writeFile(metaPath(id), JSON.stringify(info), "utf8");
        return info;
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function processJob(job: Job): Promise<void> {
    const part = partPath(job.id);
    try {
        job.archive = await processArchive(part, job.kind, job.name);
        job.state = "ready";
    } catch (error) {
        job.state = "failed";
        job.reason = failureOf(error);
        if (job.reason === "failed") console.error("[minecraft-archive] could not be read:", error);
    } finally {
        job.at = Date.now();
        await rm(part, { force: true }).catch(() => undefined);
    }
}

function isInfo(value: unknown): value is ArchiveInfo {
    if (typeof value !== "object" || value === null) return false;
    const info = value as Record<string, unknown>;
    return (
        typeof info.id === "string" &&
        SHA.test(info.id) &&
        (info.kind === "pack" || info.kind === "world") &&
        typeof info.name === "string" &&
        typeof info.bytes === "number" &&
        Array.isArray(info.dropped)
    );
}

/** What is known about a kept archive, or null when there is none by that id. */
export async function readArchive(id: string): Promise<ArchiveInfo | null> {
    if (!SHA.test(id)) return null;
    const [text, file] = await Promise.all([
        readFile(metaPath(id), "utf8").catch(() => null),
        stat(archivePath(id)).catch(() => null)
    ]);
    if (text === null || !file?.isFile()) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        return isInfo(parsed) && parsed.id === id ? parsed : null;
    } catch {
        return null;
    }
}

/** Every archive some server's environment still names. */
async function archivesInUse(): Promise<Set<string>> {
    const rows = await prisma.envVar.findMany({
        where: { key: { in: ["GENERIC_PACK", "WORLD"] }, value: { contains: "/polaris-" } },
        select: { value: true }
    });
    const used = new Set<string>();
    for (const row of rows) {
        const archive = archiveOfUrl(row.value);
        if (archive) used.add(archive.id);
    }
    return used;
}

/** Removes the archives no server names any more and the sends nobody
 *  finished, once they are a day old. */
export async function sweepArchives(now = Date.now()): Promise<{ removed: number }> {
    const names = await readdir(archiveDir()).catch(() => [] as string[]);
    if (names.length === 0) return { removed: 0 };
    const used = await archivesInUse();
    let removed = 0;
    for (const name of names) {
        const match = /^([a-f0-9]{64})\.zip$/.exec(name);
        if (!match || used.has(match[1]!)) continue;
        const info = await stat(path.join(archiveDir(), name)).catch(() => null);
        if (!info || now - info.mtimeMs < KEEP_UNUSED_MS) continue;
        await rm(path.join(archiveDir(), name), { force: true });
        await rm(metaPath(match[1]!), { force: true });
        removed += 1;
    }
    const open = new Set([...jobs.keys()]);
    for (const name of await readdir(incomingDir()).catch(() => [] as string[])) {
        const id = name.replace(/\.part$/, "").replace(/\.zip$/, "");
        if (open.has(id)) continue;
        const info = await stat(path.join(incomingDir(), name)).catch(() => null);
        if (info && now - info.mtimeMs > KEEP_UNUSED_MS) {
            await rm(path.join(incomingDir(), name), { force: true });
            removed += 1;
        }
    }
    return { removed };
}
