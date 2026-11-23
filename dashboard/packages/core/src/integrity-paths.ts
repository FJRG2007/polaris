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
 * adds `?dpl=` to some) and the path decoded: the manifest names files as they
 * sit on disk (`[[...path]]`), while a browser reports a dynamic route's chunk
 * percent-encoded (`%5B%5B...path%5D%5D`), and the two must meet.
 */
export function checkedPath(url: string, origin: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url, origin);
    } catch {
        return null;
    }
    if (parsed.origin !== origin) return null;
    if (!CODE_EXTENSIONS.some((extension) => parsed.pathname.endsWith(extension))) return null;
    return decodedPath(parsed.pathname);
}

/** Each segment decoded on its own, so an encoded slash never becomes a new one.
 *  A segment that is not valid percent-encoding stays as served. */
function decodedPath(pathname: string): string {
    return pathname
        .split("/")
        .map((segment) => {
            try {
                const decoded = decodeURIComponent(segment);
                return decoded.includes("/") ? segment : decoded;
            } catch {
                return segment;
            }
        })
        .join("/");
}

/** The address a checked path is fetched from again: its route brackets
 *  encoded the way the browser asked for it in the first place. */
export function servedPath(path: string): string {
    return path.replace(/\[/g, "%5B").replace(/\]/g, "%5D");
}

/** The SRI form of a SHA-256, as the manifest writes it. */
export async function sriDigest(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", view as Uint8Array<ArrayBuffer>));
    let binary = "";
    for (const byte of hash) binary += String.fromCharCode(byte);
    return `sha256-${btoa(binary)}`;
}
