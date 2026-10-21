/**
 * The Polaris address somebody typed, as the one form every request uses:
 * scheme and host (and port), no path, no trailing slash.
 *
 * A bare host is taken as https. Anything that is not an http(s) URL, or that
 * carries credentials, is refused rather than guessed at. Pure.
 */
export function normalizeAddress(typed: string): string | null {
    const trimmed = typed.trim();
    if (trimmed === "" || trimmed.length > 300) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.hostname === "") return null;
    return `${url.protocol}//${url.host}`;
}

/** A path from Polaris joined to the address, refusing anything that would
 *  leave it: the catalogue's paths are trusted to be paths and nothing more. */
export function joinPath(address: string, path: string): string | null {
    if (!/^\/(?!\/)[^\s\\]*$/.test(path)) return null;
    const url = new URL(path, `${address}/`);
    return url.origin === new URL(address).origin ? url.href : null;
}
