/**
 * A FiveM server's resources: what it has, what is running, and what may be done
 * to one.
 *
 * A resource is what a mod is on this game - a folder with a manifest in it - and
 * a server is almost entirely made of them. Two questions have to be answered and
 * they have different answers: what is on disk, which is a folder listing, and
 * what is actually running, which only the server can say. A resource that is
 * installed and stopped is the ordinary state after somebody adds one, and a
 * screen that only showed the running ones would show nothing they had just done.
 *
 * Pure: the panel renders these types in the browser, and the service parses the
 * container's output with the same functions.
 */

/** One resource on the server. */
export interface FivemResource {
    readonly name: string;
    /** Whether the server has it started right now. */
    readonly running: boolean;
    /** The folder it sits in under `resources`, when it is in one. FiveM groups
     *  resources into folders whose name is in brackets and it is worth showing:
     *  `[gameplay]` and `[voice]` are how a server owner thinks about them. */
    readonly group: string | null;
    /** Whether it is the one Polaris installed itself, which is not somebody's to
     *  stop by accident - stopping it opens the server to everybody. */
    readonly managed: boolean;
}

/** What may be done to one, in the words the console uses. */
export type ResourceAction = "start" | "stop" | "restart" | "ensure";

/**
 * A resource name as the console will read it back.
 *
 * The console splits on whitespace and a resource name is a folder name, so this
 * is what a folder may be called and nothing wider. Checked rather than quoted:
 * a name with a space in it is not a resource FiveM can start at all, so
 * accepting one here would only move the failure somewhere less legible.
 */
export function isResourceName(value: string): boolean {
    return /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

/**
 * The manifest files a folder has to hold to be a resource.
 *
 * Two, because the older spelling is still what a great many published resources
 * ship - a listing that only counted `fxmanifest.lua` would leave half of an
 * established server's resources off the screen.
 */
export const MANIFEST_FILES = ["fxmanifest.lua", "__resource.lua"] as const;

/** A resource as the folder listing found it. */
export interface ResourceFolder {
    readonly name: string;
    readonly group: string | null;
}

/**
 * The resource a manifest path names, and the group it sits in.
 *
 * A path is `<root>/[gameplay]/mymode/fxmanifest.lua`, so the resource is the
 * folder holding the manifest and the group is the folder above it - when that
 * folder is one of FiveM's bracketed groupings rather than `resources` itself.
 */
export function resourceOfPath(path: string, root: string): ResourceFolder | null {
    if (!path.startsWith(root)) return null;
    const parts = path
        .slice(root.length)
        .split("/")
        .filter((part) => part.length > 0);
    const name = parts[parts.length - 2];
    if (!name || !isResourceName(name)) return null;
    const above = parts[parts.length - 3];
    return { name, group: above && above.startsWith("[") ? above : null };
}

/** Every resource folder on disk, from a listing of the manifest files under
 *  `resources` - one path per line, in any order. */
export function parseResourceListing(output: string, root: string): ResourceFolder[] {
    const found = new Map<string, ResourceFolder>();
    for (const line of output.split(/\r?\n/)) {
        const resource = resourceOfPath(line.trim(), root);
        // A resource shipping both manifest spellings is listed twice; it is still
        // one resource.
        if (resource && !found.has(resource.name.toLowerCase())) found.set(resource.name.toLowerCase(), resource);
    }
    return [...found.values()];
}

/**
 * The two listings folded into one, sorted so the screen reads the same way twice.
 *
 * A resource the server reports as running but which is not on disk still appears:
 * that is what a resource started from somewhere else looks like, and hiding it
 * would leave an operator unable to stop a thing they can see in their own logs.
 */
export function foldResources(
    onDisk: readonly ResourceFolder[],
    running: readonly string[],
    managed: string
): FivemResource[] {
    const started = new Set(running.map((name) => name.toLowerCase()));
    const byName = new Map<string, FivemResource>();
    for (const entry of onDisk) {
        byName.set(entry.name.toLowerCase(), {
            name: entry.name,
            group: entry.group,
            running: started.has(entry.name.toLowerCase()),
            managed: entry.name.toLowerCase() === managed.toLowerCase()
        });
    }
    for (const name of running) {
        if (byName.has(name.toLowerCase())) continue;
        byName.set(name.toLowerCase(), {
            name,
            group: null,
            running: true,
            managed: name.toLowerCase() === managed.toLowerCase()
        });
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Where a resource may be fetched from.
 *
 * HTTPS only, and an archive rather than a repository: a resource is published as
 * a release zip or a source tarball, and anything else is a link somebody pasted
 * from the wrong place. GitHub's own "download as zip" links end in `.zip`, so
 * this is not as narrow as it reads.
 */
export function isResourceUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return false;
    }
    if (url.protocol !== "https:") return false;
    return /\.(zip|tar\.gz|tgz)$/i.test(url.pathname);
}

/** What to say when a link is refused, in the terms it was refused on. */
export const RESOURCE_URL_HINT = "A https link ending in .zip, .tar.gz or .tgz - the release file, not the page.";

/** A resource name suggested from a link, so the field is filled in rather than
 *  asked for. The archive's own file name, with the version and the extension
 *  taken off - `es_extended-1.9.4.zip` is the `es_extended` resource. */
export function resourceNameFromUrl(url: string): string {
    let path: string;
    try {
        path = new URL(url.trim()).pathname;
    } catch {
        return "";
    }
    const file = path.split("/").filter(Boolean).pop() ?? "";
    const bare = file
        .replace(/\.(zip|tar\.gz|tgz)$/i, "")
        .replace(/[-_.]?v?\d+(\.\d+)*$/, "")
        .replace(/[^A-Za-z0-9_.-]/g, "");
    return isResourceName(bare) ? bare : "";
}
