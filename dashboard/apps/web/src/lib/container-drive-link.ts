/**
 * Where Drive opens a container's files.
 *
 * A service Deploy runs on this machine is a Drive source of its own
 * (`container:<applicationId>`), and opens at the folder the container page was
 * showing. Any other container is reached through the server it runs on: what
 * outlives it, and what anybody means to open from Drive, is what is mounted into
 * it, so the folder the page shows is followed to the host folder behind it -
 * through the mount that holds it, or the first mount when the page is outside
 * them all.
 */

/** One mount, as the container's inspect reports it. */
export interface ContainerMount {
    readonly source: string;
    readonly destination: string;
}

/** A Drive path is relative to the source's root, without a leading slash. */
function relative(path: string): string {
    return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Whether `path` is `folder` or inside it. */
function within(path: string, folder: string): boolean {
    const base = folder.replace(/\/+$/, "");
    return base === "" || path === base || path.startsWith(`${base}/`);
}

/**
 * The host folder behind `path` inside the container, relative to the host's
 * root, or null when nothing of the container lives on the host as a folder (no
 * mount, or only mounts whose source is not a path - a socket's or a tmpfs's).
 */
export function hostFolderFor(mounts: readonly ContainerMount[], path: string): string | null {
    const usable = mounts.filter(
        (mount) => mount.source.startsWith("/") && mount.destination.startsWith("/")
    );
    if (usable.length === 0) return null;
    // The deepest mount wins: a volume mounted inside another one shadows it.
    const holding = usable
        .filter((mount) => within(path, mount.destination))
        .sort((a, b) => b.destination.length - a.destination.length)[0];
    if (!holding) return relative(usable[0]!.source);
    const rest = path.slice(holding.destination.replace(/\/+$/, "").length);
    return relative(`${holding.source}${rest}`);
}

/** The Drive address of a folder on a source. */
export function driveHref(connectionId: string, path: string): string {
    const query = new URLSearchParams({ c: connectionId });
    const rel = relative(path);
    if (rel) query.set("p", rel);
    return `/drive?${query.toString()}`;
}
