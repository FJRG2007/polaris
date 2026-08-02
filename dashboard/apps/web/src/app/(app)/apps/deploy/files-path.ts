/**
 * Path arithmetic for the container file browser. A browser can be rooted below
 * "/" so a volume opens on its own contents, which makes the root a floor as well
 * as a starting point: navigation is never allowed to climb out of it.
 */

/** A listable directory: absolute, and trailing-slashed so entries append cleanly. */
export function asDirectory(path: string): string {
    const trimmed = path.trim().replace(/\/+$/, "");
    if (!trimmed) return "/";
    return trimmed.startsWith("/") ? `${trimmed}/` : `/${trimmed}/`;
}

/** Where "Up" leads, floored at the root this browser is confined to. */
export function parentDirectory(path: string, base: string): string {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    const next = parts.length ? `/${parts.join("/")}/` : "/";
    return next.startsWith(base) ? next : base;
}
