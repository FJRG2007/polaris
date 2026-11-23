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

/** Where CI publishes the manifests (`.github/workflows/dashboard-publish.yml`). */
export const MANIFEST_BASE = "https://raw.githubusercontent.com/FJRG2007/polaris/integrity/manifests/";
/** The most of a manifest that is read. A build lists a few thousand files. */
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** The extensions the manifest lists (CODE_EXTENSIONS in the script). */
export const CODE_EXTENSIONS: readonly string[] = [".js", ".mjs", ".css", ".wasm"];

const stampSchema = z.string().regex(/^[0-9a-f]{16}$/);
const pathSchema = z.string().startsWith("/").max(1_024);

export const integrityManifestSchema = z.object({
    schema: z.literal(1),
    build: stampSchema,
    prefixes: z.array(pathSchema).max(16),
    files: z.record(pathSchema, z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/))
});

export type IntegrityManifest = z.infer<typeof integrityManifestSchema>;

/** One file a page loaded, hashed by the checker. */
export interface CheckedFile {
    readonly path: string;
    readonly digest: string;
}

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

/**
 * The path a loaded resource is checked under, or null when it is not one this
 * checks: another origin, or not a file of code. The query is dropped (Next.js
 * adds `?dpl=` to some), the path kept exactly as served.
 */
export function checkedPath(url: string, origin: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url, origin);
    } catch {
        return null;
    }
    if (parsed.origin !== origin) return null;
    return CODE_EXTENSIONS.some((extension) => parsed.pathname.endsWith(extension)) ? parsed.pathname : null;
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

/** The SRI form of a SHA-256, as the manifest writes it. */
export async function sriDigest(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", view as Uint8Array<ArrayBuffer>));
    let binary = "";
    for (const byte of hash) binary += String.fromCharCode(byte);
    return `sha256-${btoa(binary)}`;
}
