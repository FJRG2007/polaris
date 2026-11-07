/**
 * The newest Polaris TV build this instance can hand a TV, served from here
 * rather than from GitHub, so a set with no route to GitHub still updates.
 *
 * The release is the one the downloads page already finds (`tv-v*`, carrying
 * `polaris-tv.apk` and `SHA256SUMS`). The checksum list is read first; the APK is
 * downloaded once per version into the data directory, hashed while it arrives,
 * and kept only if it matches. A mismatch is refused, never served. Only the
 * newest verified APK of each edition is kept on disk.
 *
 * Editions: `standard` is `polaris-tv.apk`; `home-key` is `polaris-tv-home-key.apk`,
 * the same launcher with no HOME category, for firmware that uninstalls Home apps
 * at boot (NES boxes). A release without an edition's APK has none to offer.
 *
 * The same release carries the Themes & add-ons catalog (`catalog.json`) and its
 * files. Those are served from here too (`preparedTvCatalogFile`), each one
 * checked against the same SHA256SUMS, so a TV that cannot reach GitHub can
 * still browse and install them.
 *
 * Every request to GitHub goes through the vetted dispatcher (`configuredRequest`)
 * with redirects followed by hand, one checked hop at a time, and only to
 * GitHub's own hosts.
 */

import { dirname, join } from "node:path";
import { loadEnv } from "@polaris/config";
import { createHash, randomUUID } from "node:crypto";
import { configuredRequest } from "@/lib/safe-fetch";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tvDownload, tvInstallable, type AppDownload } from "@/lib/app-releases";

export const TV_APK_NAME = "polaris-tv.apk";
export const TV_CHECKSUMS_NAME = "SHA256SUMS";

export const TV_EDITIONS = ["standard", "home-key"] as const;
export type TvEdition = (typeof TV_EDITIONS)[number];

/** The edition a request names in `?edition=`: absent is the ordinary build, an
 *  unknown one is null. */
export function editionOf(request: Request): TvEdition | null {
    const asked = new URL(request.url).searchParams.get("edition");
    if (asked === null || asked === "") return "standard";
    return TV_EDITIONS.find((edition) => edition === asked) ?? null;
}

/** The release asset an edition is published as. */
export function tvApkName(edition: TvEdition): string {
    return edition === "standard" ? TV_APK_NAME : `polaris-tv-${edition}.apk`;
}

/** How long a resolved release is reused before GitHub is asked again. */
const RELEASE_TTL_MS = 10 * 60 * 1000;
/** How long a failed lookup is remembered, so a broken release is not
 *  downloaded again on every poll of every TV. */
const FAILURE_TTL_MS = 60 * 1000;
/** Ceilings on what GitHub may send: a checksum list is a line, an APK tens of MB. */
const CHECKSUMS_MAX_BYTES = 64 * 1024;
const APK_MAX_BYTES = 256 * 1024 * 1024;
/** The catalog generator's own caps (tv/tools/catalog.py). */
const CATALOG_JSON_MAX_BYTES = 512 * 1024;
const CATALOG_FILE_MAX_BYTES = 64 * 1024 * 1024;
const SCREENSHOT_MAX_BYTES = 300 * 1024;
const CHECKSUMS_TIMEOUT_MS = 15_000;
const APK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HOPS = 3;

/** A version as a tag can spell it, and nothing a path or a header could misread. */
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

export interface TvReleaseInfo {
    readonly edition: TvEdition;
    readonly versionName: string;
    /** Lowercase hex, from the release's SHA256SUMS. */
    readonly sha256: string;
    readonly apkUrl: string;
}

export interface TvApk extends TvReleaseInfo {
    readonly path: string;
    readonly size: number;
}

/** Why there is no APK to hand out. "none" is the ordinary answer for a
 *  repository that has released no TV build. */
export type TvApkFailure = "none" | "unreachable" | "mismatch" | "too-large";

export class TvReleaseError extends Error {
    constructor(readonly reason: Exclude<TvApkFailure, "none">) {
        super(`Polaris TV release: ${reason}`);
    }
}

/** The SHA-256 listed for one file in a `sha256sum` output, lowercased. */
export function checksumFor(listing: string, file: string): string | null {
    return checksumsOf(listing).get(file) ?? null;
}

/** Every file a `sha256sum` output lists, with its SHA-256 lowercased. The first line for a name wins. */
export function checksumsOf(listing: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of listing.split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
        if (match && !sums.has(match[2]!)) sums.set(match[2]!, match[1]!.toLowerCase());
    }
    return sums;
}

/** The catalog's own file. */
export const TV_CATALOG_NAME = "catalog.json";

const CATALOG_FILE =
    /^(?:theme-[a-z0-9][a-z0-9_-]{0,63}\.(?:zip|jpg)|addon-[a-z0-9][a-z0-9_-]{0,63}\.(?:apk|jpg))$/;

/**
 * A file of the Themes & add-ons catalog by the only names tv/tools/catalog.py
 * writes: `catalog.json`, `theme-<id>.zip|jpg`, `addon-<id>.apk|jpg`. Anything
 * else - a path, a dot file, the launcher's own APK - is not one.
 */
export function catalogFileName(name: string | null | undefined): name is string {
    return name === TV_CATALOG_NAME || CATALOG_FILE.test(name ?? "");
}

/** The most a catalog file may weigh, by its kind. */
export function catalogFileCap(name: string): number {
    if (name === TV_CATALOG_NAME) return CATALOG_JSON_MAX_BYTES;
    return name.endsWith(".jpg") ? SCREENSHOT_MAX_BYTES : CATALOG_FILE_MAX_BYTES;
}

/** Only GitHub's own hosts are followed: the API names the asset on github.com,
 *  which redirects to its object storage. */
export function githubHost(url: URL): boolean {
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".githubusercontent.com");
}

async function fromGitHub(address: string, timeoutMs: number): Promise<Response> {
    let url = new URL(address);
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
        if (!githubHost(url)) throw new TvReleaseError("unreachable");
        const response = await configuredRequest(
            url.href,
            { headers: { "user-agent": "polaris", accept: "application/octet-stream" }, timeoutMs },
            { allowPrivate: false }
        ).catch(() => null);
        if (!response) throw new TvReleaseError("unreachable");
        const next = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && next) {
            await response.body?.cancel().catch(() => undefined);
            url = new URL(next, url);
            continue;
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new TvReleaseError("unreachable");
        }
        return response;
    }
    throw new TvReleaseError("unreachable");
}

async function readText(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new TvReleaseError("unreachable");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new TvReleaseError("too-large");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function fileUrl(release: AppDownload, name: string): string | null {
    return release.files.find((file) => file.name === name)?.url ?? null;
}

interface Held<T> {
    readonly at: number;
    readonly value: T | null;
    readonly failure: TvReleaseError | null;
}

/** The newest release as this instance knows it: its version, and every file it lists a checksum for. */
interface TvRelease {
    readonly versionName: string;
    readonly checksums: ReadonlyMap<string, string>;
    readonly urls: ReadonlyMap<string, string>;
}

let infoHeld: Held<TvRelease> | null = null;
let infoRunning: Promise<TvRelease | null> | null = null;
/** An edition whose APK was downloaded and refused, so the next poll does not download it again. Per edition:
 *  a bad Home key build must not stop the ordinary one, or the catalog. */
const refused = new Map<TvEdition, { readonly at: number; readonly failure: TvReleaseError }>();

async function lookRelease(): Promise<TvRelease | null> {
    const release = await tvDownload(loadEnv().POLARIS_REPO);
    if (!release || !tvInstallable(release)) return null;
    const versionName = release.version.trim();
    const sumsUrl = fileUrl(release, TV_CHECKSUMS_NAME);
    // The ordinary launcher is what makes a release a TV release; the other editions ride along with it.
    if (!VERSION.test(versionName) || !sumsUrl || !fileUrl(release, TV_APK_NAME)) return null;
    const listing = await readText(
        await fromGitHub(sumsUrl, CHECKSUMS_TIMEOUT_MS),
        CHECKSUMS_MAX_BYTES
    );
    const checksums = checksumsOf(listing);
    if (!checksums.has(TV_APK_NAME)) throw new TvReleaseError("mismatch");
    const urls = new Map(release.files.map((file) => [file.name, file.url] as const));
    return { versionName, checksums, urls };
}

/**
 * The newest TV release of an edition and its published checksum, without
 * downloading the APK. Null when none is released, or when the release has no
 * APK of that edition. Cached for ten minutes, failures for one.
 */
export async function tvReleaseInfo(
    edition: TvEdition = "standard"
): Promise<TvReleaseInfo | null> {
    const refusal = refused.get(edition);
    if (refusal && Date.now() - refusal.at < FAILURE_TTL_MS) throw refusal.failure;
    const release = await tvRelease();
    if (!release) return null;
    const apkName = tvApkName(edition);
    const apkUrl = release.urls.get(apkName);
    if (!apkUrl) return null;
    const sha256 = release.checksums.get(apkName);
    if (!sha256) throw new TvReleaseError("mismatch");
    return { edition, versionName: release.versionName, sha256, apkUrl };
}

async function tvRelease(): Promise<TvRelease | null> {
    const now = Date.now();
    if (infoHeld) {
        const ttl = infoHeld.failure ? FAILURE_TTL_MS : RELEASE_TTL_MS;
        if (now - infoHeld.at < ttl) {
            if (infoHeld.failure) throw infoHeld.failure;
            return infoHeld.value;
        }
    }
    if (infoRunning) return infoRunning;
    infoRunning = lookRelease()
        .then((value) => {
            infoHeld = { at: Date.now(), value, failure: null };
            return value;
        })
        .catch((caught: unknown) => {
            const failure =
                caught instanceof TvReleaseError ? caught : new TvReleaseError("unreachable");
            infoHeld = { at: Date.now(), value: null, failure };
            throw failure;
        })
        .finally(() => {
            infoRunning = null;
        });
    return infoRunning;
}

function cacheDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "tv-updates");
}

/** The name a verified APK is kept under: its version and hash, so a file on disk
 *  is only ever trusted for the release it was checked against. */
function keptName(info: TvReleaseInfo): string {
    return `${keptPrefix(info.edition)}${info.versionName}-${info.sha256.slice(0, 16)}.apk`;
}

function keptPrefix(edition: TvEdition): string {
    return edition === "standard" ? "polaris-tv-" : `polaris-tv-${edition}-`;
}

/** The edition a kept file belongs to, read back from its name. */
function keptEdition(name: string): TvEdition {
    return (
        TV_EDITIONS.find(
            (edition) => edition !== "standard" && name.startsWith(keptPrefix(edition))
        ) ?? "standard"
    );
}

async function hashFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

/** Paths whose contents were hashed and matched in this process. */
const verified = new Map<string, { sha256: string; size: number }>();

/** One file of the release into `target`, kept only when it hashes to `sha256` and stays under `maxBytes`. */
async function download(
    url: string,
    sha256: string,
    target: string,
    maxBytes: number
): Promise<number> {
    const response = await fromGitHub(url, APK_TIMEOUT_MS);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new TvReleaseError("too-large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TvReleaseError("unreachable");
    const part = join(dirname(target), `.${randomUUID()}.part`);
    const out = createWriteStream(part);
    const failed = new Promise<never>((_, reject) => out.on("error", reject));
    failed.catch(() => undefined);
    const hash = createHash("sha256");
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytes) throw new TvReleaseError("too-large");
            hash.update(value);
            if (!out.write(value)) {
                await Promise.race([new Promise((resolve) => out.once("drain", resolve)), failed]);
            }
        }
        await Promise.race([
            new Promise<void>((resolve, reject) =>
                out.end((error?: Error | null) => (error ? reject(error) : resolve()))
            ),
            failed
        ]);
        if (hash.digest("hex") !== sha256) throw new TvReleaseError("mismatch");
        await rename(part, target);
        return total;
    } catch (caught) {
        await reader.cancel().catch(() => undefined);
        out.destroy();
        await rm(part, { force: true }).catch(() => undefined);
        throw caught instanceof TvReleaseError ? caught : new TvReleaseError("unreachable");
    }
}

/** A partial download older than any download may run is left from a crash. */
async function abandoned(part: string): Promise<boolean> {
    const held = await stat(part).catch(() => null);
    return Boolean(held && Date.now() - held.mtimeMs > APK_TIMEOUT_MS * 2);
}

async function prepare(info: TvReleaseInfo): Promise<TvApk> {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, keptName(info));
    const known = verified.get(path);
    if (known?.sha256 === info.sha256) return { ...info, path, size: known.size };

    // A file left by an earlier run is trusted only after it hashes to the
    // published checksum again.
    const existing = await stat(path).catch(() => null);
    let size: number;
    if (existing && (await hashFile(path)) === info.sha256) size = existing.size;
    else {
        await rm(path, { force: true });
        size = await download(info.apkUrl, info.sha256, path, APK_MAX_BYTES);
    }
    verified.set(path, { sha256: info.sha256, size });

    // Only the newest verified build of this edition is kept; the other edition's stays.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (join(dir, name) === path) continue;
        if (name.endsWith(".part") && !(await abandoned(join(dir, name)))) continue;
        if (!name.endsWith(".part") && keptEdition(name) !== info.edition) continue;
        await rm(join(dir, name), { force: true }).catch(() => undefined);
        verified.delete(join(dir, name));
    }
    return { ...info, path, size };
}

const preparing = new Map<string, Promise<TvApk>>();

/**
 * The newest TV APK, downloaded and verified on this instance. Null when no TV
 * build is released; throws `TvReleaseError` when one is but cannot be served.
 * Concurrent callers share one download.
 */
export async function preparedTvApk(edition: TvEdition = "standard"): Promise<TvApk | null> {
    const info = await tvReleaseInfo(edition);
    if (!info) return null;
    const key = keptName(info);
    const running = preparing.get(key);
    if (running) return running;
    const started = prepare(info)
        .catch((caught: unknown) => {
            if (caught instanceof TvReleaseError) {
                // Remember the refusal so the next poll does not download it again.
                refused.set(edition, { at: Date.now(), failure: caught });
            }
            throw caught;
        })
        .finally(() => preparing.delete(key));
    preparing.set(key, started);
    return started;
}

export interface TvCatalogFile {
    readonly versionName: string;
    readonly name: string;
    readonly sha256: string;
    readonly path: string;
    readonly size: number;
}

function catalogDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "tv-catalog");
}

async function prepareCatalogFile(
    versionName: string,
    name: string,
    sha256: string,
    url: string
): Promise<TvCatalogFile> {
    const root = catalogDir();
    // A version is a folder name here: one that is all dots would leave the folder.
    if (/^\.+$/.test(versionName)) throw new TvReleaseError("unreachable");
    // One folder per release, named by its version, so a file is only ever
    // trusted for the release whose checksum list it was checked against.
    const dir = join(root, versionName);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    const known = verified.get(path);
    if (known?.sha256 === sha256) return { versionName, name, sha256, path, size: known.size };
    const existing = await stat(path).catch(() => null);
    let size: number;
    if (existing && (await hashFile(path)) === sha256) size = existing.size;
    else {
        await rm(path, { force: true });
        size = await download(url, sha256, path, catalogFileCap(name));
    }
    verified.set(path, { sha256, size });
    // Only the newest release's files are kept.
    for (const other of await readdir(root).catch(() => [] as string[])) {
        if (other === versionName) continue;
        await rm(join(root, other), { recursive: true, force: true }).catch(() => undefined);
        for (const held of verified.keys()) {
            if (held.startsWith(join(root, other))) verified.delete(held);
        }
    }
    return { versionName, name, sha256, path, size };
}

const preparingCatalog = new Map<string, Promise<TvCatalogFile>>();

/**
 * One file of the newest release's Themes & add-ons catalog, downloaded once
 * and verified on this instance. Null when no TV build is released, when the
 * name is not a catalog file, or when the release does not carry it (one from
 * before the catalog). Throws `TvReleaseError` when it does but cannot be served.
 */
export async function preparedTvCatalogFile(name: string): Promise<TvCatalogFile | null> {
    if (!catalogFileName(name)) return null;
    const release = await tvRelease();
    if (!release) return null;
    const sha256 = release.checksums.get(name);
    const url = release.urls.get(name);
    if (!sha256 || !url) return null;
    const key = `${release.versionName}/${name}`;
    const running = preparingCatalog.get(key);
    if (running) return running;
    const started = prepareCatalogFile(release.versionName, name, sha256, url).finally(() =>
        preparingCatalog.delete(key)
    );
    preparingCatalog.set(key, started);
    return started;
}

/** Forget every cached answer. For tests. */
export function resetTvReleaseCache(): void {
    infoHeld = null;
    infoRunning = null;
    refused.clear();
    verified.clear();
    preparing.clear();
    preparingCatalog.clear();
}
