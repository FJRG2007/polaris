/**
 * The parts of the code check (docs/integrity.md) a page itself runs: which
 * loaded files are checked and their digests. No zod and no schema, so the
 * desktop preload and the extension's page script that import it stay small.
 */

/** The extensions the manifest lists (CODE_EXTENSIONS in the script). */
export const CODE_EXTENSIONS: readonly string[] = [".js", ".mjs", ".css", ".wasm"];

/** One file a page loaded, hashed by the checker. */
export interface CheckedFile {
    readonly path: string;
    readonly digest: string;
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

/** The SRI form of a SHA-256, as the manifest writes it. */
export async function sriDigest(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", view as Uint8Array<ArrayBuffer>));
    let binary = "";
    for (const byte of hash) binary += String.fromCharCode(byte);
    return `sha256-${btoa(binary)}`;
}
