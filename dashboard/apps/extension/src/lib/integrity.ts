/**
 * The worker's half of the page check (docs/integrity.md): on a page of a
 * Polaris server somebody added, the page script hashes the files of code the
 * page loaded and this decides what they mean.
 *
 * The build stamp is asked of the server; the manifest is fetched from GitHub,
 * never from the server, and kept per stamp because a build never changes. A
 * server that does not answer a stamp, or one whose build has no manifest, is
 * "cannot verify" - an install from before manifests were published is that,
 * and it is not the same as changed.
 */

import {
    judge,
    manifestUrl,
    MANIFEST_MAX_BYTES,
    readManifest,
    readStamp,
    type CheckedFile,
    type IntegrityManifest,
    type IntegrityVerdict
} from "@polaris/core/integrity";

/** The most files one page may hand over: a dashboard page loads a few hundred. */
export const MAX_FILES = 2_000;
const TIMEOUT_MS = 10_000;
/** A few servers, a few builds each, between worker restarts. */
const CACHE_ENTRIES = 8;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A manifest per stamp; null is "GitHub has none for it", kept like an answer. */
const manifests = new Map<string, IntegrityManifest | null>();

async function readCapped(response: Response, max: number): Promise<string | null> {
    const text = await response.text();
    return text.length > max ? null : text;
}

async function askStamp(origin: string, fetcher: Fetch): Promise<string | null> {
    const response = await fetcher(`${origin}/api/version`, {
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const text = await readCapped(response, 4_096);
    if (text === null) return null;
    try {
        return readStamp((JSON.parse(text) as { build?: unknown }).build);
    } catch {
        return null;
    }
}

async function askManifest(stamp: string, fetcher: Fetch): Promise<IntegrityManifest | null> {
    if (manifests.has(stamp)) return manifests.get(stamp) ?? null;
    const response = await fetcher(manifestUrl(stamp), {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // Only a definite "there is none" is remembered; a failure is asked again.
    if (response.status === 404) {
        remember(stamp, null);
        return null;
    }
    if (!response.ok) throw new Error(`manifest answered ${response.status}`);
    const text = await readCapped(response, MANIFEST_MAX_BYTES);
    const manifest = text === null ? null : readManifest(text, stamp);
    remember(stamp, manifest);
    return manifest;
}

function remember(stamp: string, manifest: IntegrityManifest | null): void {
    manifests.delete(stamp);
    manifests.set(stamp, manifest);
    while (manifests.size > CACHE_ENTRIES) manifests.delete(manifests.keys().next().value as string);
}

/** What the page script sent, kept to what it is allowed to say. */
export function readFiles(raw: unknown): CheckedFile[] | null {
    if (!Array.isArray(raw) || raw.length > MAX_FILES) return null;
    const files: CheckedFile[] = [];
    for (const entry of raw) {
        const path = (entry as { path?: unknown })?.path;
        const digest = (entry as { digest?: unknown })?.digest;
        if (typeof path !== "string" || typeof digest !== "string") return null;
        if (!path.startsWith("/") || path.length > 1_024 || digest.length > 100) return null;
        files.push({ path, digest });
    }
    return files;
}

/**
 * The verdict for a page of `origin`. A server or GitHub that cannot be reached
 * is "cannot verify" rather than an error: the page is not blocked for a network
 * that failed, only for code that differs.
 */
export async function checkPage(
    origin: string,
    files: readonly CheckedFile[],
    fetcher: Fetch = (url, init) => fetch(url, init)
): Promise<IntegrityVerdict> {
    const stamp = await askStamp(origin, fetcher).catch(() => null);
    if (!stamp) return judge(null, null, files);
    const manifest = await askManifest(stamp, fetcher).catch(() => null);
    return judge(stamp, manifest, files);
}

/** For tests: forget every manifest. */
export function forgetManifests(): void {
    manifests.clear();
}

/** The match pattern a page script is registered on for a server's origin.
 *  Without the port, which match patterns do not take; the worker checks the
 *  exact origin of every page that asks. */
export function originPattern(origin: string): string | null {
    try {
        const url = new URL(origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        return `${url.protocol}//${url.hostname}/*`;
    } catch {
        return null;
    }
}
