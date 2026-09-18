/**
 * Keeping a copy of the pictures the mod screens borrow.
 *
 * Every mod picture on the games panels belongs to somebody else - Steam's
 * Workshop, Modrinth's CDN - and is fetched through Polaris rather than by the
 * browser, so the operator's machine never has to talk to them. That fixes who
 * asks, and leaves the other half: the moment one of those hosts moves a file,
 * takes an item down or is simply unreachable, a screen that was working goes
 * blank, and it goes blank for a mod that is still installed and still running.
 *
 * So the bytes are kept here the first time they arrive. After that a screen is
 * drawn from this disk and the far host is asked only for what is missing - which
 * makes the panel faster on every later visit and, more to the point, means the
 * pictures for the mods a server actually runs survive the place they came from.
 *
 * A cache and nothing more: it holds only what was already fetched, it is keyed
 * by the address it came from, and deleting the folder costs one slow screen. It
 * lives on Polaris's own disk rather than through the storage targets, because a
 * cache belongs next to the thing it speeds up and never on somebody's NAS.
 */

import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

/** What each type is written as, and the only types that are kept at all. */
const EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg"
};

const BY_EXTENSION = new Map(Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type]));

/** Big enough for any preview either host serves, small enough that a cache
 *  cannot be filled by one file. */
export const MAX_CACHED_IMAGE = 4 * 1024 * 1024;

function folder(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "mod-icons");
}

/**
 * Where one address is kept.
 *
 * Named after a hash of the URL rather than after anything in it: an address is
 * not a filename, it is attacker-influenced in the general case, and a hash is
 * both fixed-length and incapable of naming a folder above this one.
 */
function pathFor(url: string, extension: string): string {
    const name = createHash("sha256").update(url).digest("hex");
    return join(folder(), `${name}.${extension}`);
}

/** The copy on disk, or null when there is not one. */
export async function cachedModImage(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    for (const [extension, type] of BY_EXTENSION) {
        try {
            return { bytes: await readFile(pathFor(url, extension)), type };
        } catch {
            // Not this one. A missing file is the ordinary case, not a fault.
        }
    }
    return null;
}

/** How long one picture gets before it is given up on. This runs behind
 *  somebody's save, so it is a bound on hanging rather than a budget. */
const WARM_TIMEOUT_MS = 8000;

/**
 * Fetch and keep the pictures for a set of mods now, rather than the first time
 * somebody looks at them.
 *
 * Called when a server's mod list is saved, which is the moment those pictures
 * stop being a browsing convenience and start being the ones that have to keep
 * drawing: they belong to what this server runs. Everything already on disk is
 * skipped, so a save that changed one mod fetches one picture.
 *
 * Best effort throughout and never awaited by the save. The caller says which
 * addresses are acceptable, so this cannot be pointed at an arbitrary host by
 * anything that reaches it.
 */
export async function warmModImages(
    urls: readonly (string | null)[],
    allowed: (url: string) => boolean,
    sniff: (bytes: Uint8Array) => string | undefined
): Promise<void> {
    for (const url of urls) {
        if (!url || !allowed(url)) continue;
        if (await cachedModImage(url)) continue;
        try {
            const answer = await fetch(url, { signal: AbortSignal.timeout(WARM_TIMEOUT_MS) });
            if (!answer.ok) continue;
            const bytes = new Uint8Array(await answer.arrayBuffer());
            if (bytes.byteLength > MAX_CACHED_IMAGE) continue;
            const type = sniff(bytes.slice(0, 16));
            if (type) await keepModImage(url, bytes, type);
        } catch {
            // Unreachable, or not an image. The screen falls back to asking for
            // it directly, which is where it was before this existed.
        }
    }
}

/**
 * Keep a copy, best effort.
 *
 * Never throws: this runs on the way past while somebody is waiting for a
 * picture, and a full disk or a read-only volume is a reason to serve the image
 * anyway rather than to fail the request that fetched it.
 *
 * Written to a neighbouring name and moved into place, so a reader never opens a
 * half-written file - two tabs drawing the same mods screen will genuinely do
 * this at the same moment.
 */
export async function keepModImage(url: string, bytes: Uint8Array, type: string): Promise<void> {
    const extension = EXTENSIONS[type];
    if (!extension || bytes.byteLength === 0 || bytes.byteLength > MAX_CACHED_IMAGE) return;
    const path = pathFor(url, extension);
    const temporary = `${path}.${process.pid}.part`;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, bytes);
        await rename(temporary, path);
    } catch {
        // The screen still has its picture. The next visit tries again.
    }
}
