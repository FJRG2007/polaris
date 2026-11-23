/**
 * Whether a Polaris page runs the code Polaris built.
 *
 * Every published build has a signed manifest of the files of code its web
 * server serves (dashboard/scripts/integrity-manifest.mjs), published by CI on
 * the repository's `integrity` branch under the build stamp `/api/version`
 * answers. A checker - the browser extension, the desktop app - hashes what a
 * page loaded from its own origin and asks {@link judge} for the verdict.
 *
 * The manifest is fetched from GitHub, never from the server being checked: a
 * server that was changed would hand over a manifest that agrees with it.
 * See docs/integrity.md for what this does and does not catch.
 */

import { z } from "zod";
import type { CheckedFile } from "./integrity-paths";

export { CODE_EXTENSIONS, checkedPath, servedPath, sriDigest, type CheckedFile } from "./integrity-paths";

/** Where CI publishes the manifests (`.github/workflows/dashboard-publish.yml`). */
export const MANIFEST_BASE = "https://raw.githubusercontent.com/FJRG2007/polaris/integrity/manifests/";
/** The most of a manifest that is read. A build lists a few thousand files. */
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const stampSchema = z.string().regex(/^[0-9a-f]{16}$/);
const pathSchema = z.string().startsWith("/").max(1_024);

export const integrityManifestSchema = z.object({
    schema: z.literal(1),
    build: stampSchema,
    prefixes: z.array(pathSchema).max(16),
    files: z.record(pathSchema, z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/))
});

export type IntegrityManifest = z.infer<typeof integrityManifestSchema>;


export type IntegrityVerdict =
    | { readonly kind: "verified"; readonly build: string; readonly checked: number }
    | { readonly kind: "changed"; readonly build: string; readonly paths: readonly string[] }
    | { readonly kind: "unverifiable"; readonly reason: "no-stamp" | "no-manifest" | "nothing-loaded" };

/** The build stamp, when it is one; `/api/version` answers null on a source build. */
export function readStamp(value: unknown): string | null {
    const parsed = stampSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function manifestUrl(stamp: string): string {
    return `${MANIFEST_BASE}${stamp}.json`;
}

/** A manifest, or null when the text is not one, or is one for another build. */
export function readManifest(text: string, stamp: string): IntegrityManifest | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    const parsed = integrityManifestSchema.safeParse(raw);
    return parsed.success && parsed.data.build === stamp ? parsed.data : null;
}

/** Whether a path has to be on the list: under a prefix the build owns whole,
 *  or listed by name. Anything else (a route, an app bundle) is not checked. */
function accountable(manifest: IntegrityManifest, path: string): boolean {
    return path in manifest.files || manifest.prefixes.some((prefix) => path.startsWith(prefix));
}

/**
 * The verdict for a page. Changed when any file it loaded differs from the
 * manifest or is under a prefix the build owns without being listed. Never
 * "verified" without a manifest: an old server or a source build is "cannot
 * verify", which is not the same as safe and not the same as changed.
 */
export function judge(
    stamp: string | null,
    manifest: IntegrityManifest | null,
    files: readonly CheckedFile[]
): IntegrityVerdict {
    if (!stamp) return { kind: "unverifiable", reason: "no-stamp" };
    if (!manifest || manifest.build !== stamp) return { kind: "unverifiable", reason: "no-manifest" };
    const checked = files.filter((file) => accountable(manifest, file.path));
    if (checked.length === 0) return { kind: "unverifiable", reason: "nothing-loaded" };
    const paths = [
        ...new Set(checked.filter((file) => manifest.files[file.path] !== file.digest).map((file) => file.path))
    ].sort();
    return paths.length > 0
        ? { kind: "changed", build: stamp, paths }
        : { kind: "verified", build: stamp, checked: checked.length };
}

/** The most files one page may hand over: a dashboard page loads a few hundred. */
export const MAX_FILES = 2_000;
const TIMEOUT_MS = 10_000;
/** A few servers, a few builds each, between restarts. */
const CACHE_ENTRIES = 8;

export type IntegrityFetch = (url: string, init: RequestInit) => Promise<Response>;

async function readCapped(response: Response, max: number): Promise<string | null> {
    const text = await response.text();
    return text.length > max ? null : text;
}

/** What a page said it loaded, kept to what it is allowed to say. */
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

export interface IntegrityChecker {
    /** The build stamp `origin` answers, or null when it answers none. */
    stamp(origin: string): Promise<string | null>;
    /** The signed manifest of a build, from GitHub; null when there is none. */
    manifest(stamp: string): Promise<IntegrityManifest | null>;
    /** The verdict for files a page of `origin` loaded. */
    check(origin: string, files: readonly CheckedFile[]): Promise<IntegrityVerdict>;
    /** For tests: forget every manifest. */
    forget(): void;
}

/**
 * The checker the extension's worker and the desktop app's main process share.
 * The stamp is asked of the server; the manifest is fetched from GitHub, never
 * from the server, and kept per stamp because a build never changes. A server
 * or GitHub that cannot be reached is "cannot verify" rather than an error: a
 * page is not blocked for a network that failed, only for code that differs.
 */
export function createIntegrityChecker(fetcher: IntegrityFetch = (url, init) => fetch(url, init)): IntegrityChecker {
    /** A manifest per stamp; null is "GitHub has none for it", kept like an answer. */
    const manifests = new Map<string, IntegrityManifest | null>();
    const remember = (stamp: string, manifest: IntegrityManifest | null): void => {
        manifests.delete(stamp);
        manifests.set(stamp, manifest);
        while (manifests.size > CACHE_ENTRIES) manifests.delete(manifests.keys().next().value as string);
    };
    const stamp = async (origin: string): Promise<string | null> => {
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
    };
    const manifest = async (build: string): Promise<IntegrityManifest | null> => {
        if (manifests.has(build)) return manifests.get(build) ?? null;
        const response = await fetcher(manifestUrl(build), {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        // Only a definite "there is none" is remembered; a failure is asked again.
        if (response.status === 404) {
            remember(build, null);
            return null;
        }
        if (!response.ok) throw new Error(`manifest answered ${response.status}`);
        const text = await readCapped(response, MANIFEST_MAX_BYTES);
        const found = text === null ? null : readManifest(text, build);
        remember(build, found);
        return found;
    };
    return {
        stamp,
        manifest,
        async check(origin, files) {
            const build = await stamp(origin).catch(() => null);
            if (!build) return judge(null, null, files);
            return judge(build, await manifest(build).catch(() => null), files);
        },
        forget: () => manifests.clear()
    };
}
