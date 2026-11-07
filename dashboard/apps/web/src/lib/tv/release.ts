/**
 * The newest Polaris TV build this instance can hand a TV, served from here
 * rather than from GitHub, so a set with no route to GitHub still updates.
 *
 * The release is the one the downloads page already finds (`tv-v*`, carrying
 * `polaris-tv.apk` and `SHA256SUMS`). The checksum list is read first; the APK is
 * downloaded once per version into the data directory, hashed while it arrives,
 * and kept only if it matches. A mismatch is refused, never served. Only the
 * newest verified APK is kept on disk.
 *
 * Every request to GitHub goes through the vetted dispatcher (`configuredRequest`)
 * with redirects followed by hand, one checked hop at a time, and only to
 * GitHub's own hosts.
 */

import { join } from "node:path";
import { loadEnv } from "@polaris/config";
import { createHash, randomUUID } from "node:crypto";
import { configuredRequest } from "@/lib/safe-fetch";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tvDownload, tvInstallable, type AppDownload } from "@/lib/app-releases";

export const TV_APK_NAME = "polaris-tv.apk";
export const TV_CHECKSUMS_NAME = "SHA256SUMS";

/** How long a resolved release is reused before GitHub is asked again. */
const RELEASE_TTL_MS = 10 * 60 * 1000;
/** How long a failed lookup is remembered, so a broken release is not
 *  downloaded again on every poll of every TV. */
const FAILURE_TTL_MS = 60 * 1000;
/** Ceilings on what GitHub may send: a checksum list is a line, an APK tens of MB. */
const CHECKSUMS_MAX_BYTES = 64 * 1024;
const APK_MAX_BYTES = 256 * 1024 * 1024;
const CHECKSUMS_TIMEOUT_MS = 15_000;
const APK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HOPS = 3;

/** A version as a tag can spell it, and nothing a path or a header could misread. */
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

export interface TvReleaseInfo {
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
    for (const line of listing.split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
        if (match && match[2] === file) return match[1]!.toLowerCase();
    }
    return null;
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

let infoHeld: Held<TvReleaseInfo> | null = null;
let infoRunning: Promise<TvReleaseInfo | null> | null = null;

async function lookInfo(): Promise<TvReleaseInfo | null> {
    const release = await tvDownload(loadEnv().POLARIS_REPO);
    if (!release || !tvInstallable(release)) return null;
    const versionName = release.version.trim();
    const apkUrl = fileUrl(release, TV_APK_NAME);
    const sumsUrl = fileUrl(release, TV_CHECKSUMS_NAME);
    if (!VERSION.test(versionName) || !apkUrl || !sumsUrl) return null;
    const listing = await readText(
        await fromGitHub(sumsUrl, CHECKSUMS_TIMEOUT_MS),
        CHECKSUMS_MAX_BYTES
    );
    const sha256 = checksumFor(listing, TV_APK_NAME);
    if (!sha256) throw new TvReleaseError("mismatch");
    return { versionName, sha256, apkUrl };
}

/**
 * The newest TV release and its published checksum, without downloading the
 * APK. Null when none is released. Cached for ten minutes, failures for one.
 */
export async function tvReleaseInfo(): Promise<TvReleaseInfo | null> {
    const now = Date.now();
    if (infoHeld) {
        const ttl = infoHeld.failure ? FAILURE_TTL_MS : RELEASE_TTL_MS;
        if (now - infoHeld.at < ttl) {
            if (infoHeld.failure) throw infoHeld.failure;
            return infoHeld.value;
        }
    }
    if (infoRunning) return infoRunning;
    infoRunning = lookInfo()
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
    return `polaris-tv-${info.versionName}-${info.sha256.slice(0, 16)}.apk`;
}

async function hashFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

/** Paths whose contents were hashed and matched in this process. */
const verified = new Map<string, { sha256: string; size: number }>();

async function download(info: TvReleaseInfo, target: string): Promise<number> {
    const response = await fromGitHub(info.apkUrl, APK_TIMEOUT_MS);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > APK_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new TvReleaseError("too-large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TvReleaseError("unreachable");
    const part = join(cacheDir(), `.${randomUUID()}.part`);
    const out = createWriteStream(part);
    const hash = createHash("sha256");
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > APK_MAX_BYTES) throw new TvReleaseError("too-large");
            hash.update(value);
            if (!out.write(value)) await new Promise((resolve) => out.once("drain", resolve));
        }
        await new Promise<void>((resolve, reject) =>
            out.end((error?: Error | null) => (error ? reject(error) : resolve()))
        );
        if (hash.digest("hex") !== info.sha256) throw new TvReleaseError("mismatch");
        await rename(part, target);
        return total;
    } catch (caught) {
        await reader.cancel().catch(() => undefined);
        out.destroy();
        await rm(part, { force: true }).catch(() => undefined);
        throw caught instanceof TvReleaseError ? caught : new TvReleaseError("unreachable");
    }
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
        size = await download(info, path);
    }
    verified.set(path, { sha256: info.sha256, size });

    // Only the newest verified build is kept.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (join(dir, name) === path) continue;
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
export async function preparedTvApk(): Promise<TvApk | null> {
    const info = await tvReleaseInfo();
    if (!info) return null;
    const key = keptName(info);
    const running = preparing.get(key);
    if (running) return running;
    const started = prepare(info)
        .catch((caught: unknown) => {
            if (caught instanceof TvReleaseError) {
                // Remember the refusal so the next poll does not download it again.
                infoHeld = { at: Date.now(), value: null, failure: caught };
            }
            throw caught;
        })
        .finally(() => preparing.delete(key));
    preparing.set(key, started);
    return started;
}

/** Forget every cached answer. For tests. */
export function resetTvReleaseCache(): void {
    infoHeld = null;
    infoRunning = null;
    verified.clear();
    preparing.clear();
}
