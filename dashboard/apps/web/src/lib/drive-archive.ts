/**
 * Shared Drive archive helpers: collecting zip sources for a set of paths (used
 * by both the streaming download route and the save-to-NAS action) and writing a
 * generated zip to a storage driver, optionally AES-encrypted with a password.
 *
 * Store-only zips reuse the dependency-free streaming writer (zip-stream.ts).
 * Password-protected zips use archiver + archiver-zip-encrypted (AES-256) - never
 * hand-rolled crypto. Both stream, so a large bundle is never fully buffered.
 */

import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import * as archiverModule from "archiver";
import archiverZipEncrypted from "archiver-zip-encrypted";
import type { StorageDriver } from "@polaris/storage";

// archiver exports (via `export =`) a callable factory plus a namespace of types.
// Reshape it to a typed callable usable from this ESM module.
const archiver = archiverModule as unknown as {
    (format: string, options?: Record<string, unknown>): archiverModule.Archiver;
    registerFormat(name: string, mod: unknown): void;
};
import { isReservedRootPath } from "@/lib/system-paths";
import { createZipStream, type ZipSource } from "@/lib/zip-stream";

/** Hard ceiling on directories walked so a pathological tree cannot hang. */
const MAX_NODES = 50000;

/** Base name of a relative path ("a/b/c" -> "c"). */
export function baseNameOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
}

// The AES-encrypted format is registered on archiver's global registry exactly
// once; registering twice throws.
let encryptedRegistered = false;
function ensureEncryptedFormat(): void {
    if (encryptedRegistered) return;
    archiver.registerFormat("zip-encrypted", archiverZipEncrypted);
    encryptedRegistered = true;
}

/** Walk one requested path, yielding zip sources with archive-relative names. */
async function* walk(
    driver: StorageDriver,
    root: string,
    lockedRoots: Set<string>
): AsyncGenerator<ZipSource> {
    const rootName = baseNameOf(root);
    let stat;
    try {
        stat = await driver.stat(root);
    } catch {
        return; // A vanished/unreadable item is skipped rather than failing the bundle.
    }
    if (stat.kind === "file") {
        yield { name: rootName, kind: "file", size: stat.size, mtime: stat.modifiedAt, body: () => driver.readStream(root) };
        return;
    }

    let nodes = 0;
    const queue: Array<{ path: string; archive: string }> = [{ path: root, archive: rootName }];
    yield { name: `${rootName}/`, kind: "dir", size: 0n, mtime: stat.modifiedAt };
    while (queue.length > 0) {
        if (nodes >= MAX_NODES) break;
        const current = queue.shift()!;
        nodes++;
        let listing;
        try {
            listing = await driver.list(current.path);
        } catch {
            continue;
        }
        for (const entry of listing.entries) {
            if (isReservedRootPath(entry.path)) continue;
            const archivePath = `${current.archive}/${entry.name}`;
            if (entry.kind === "dir") {
                if (lockedRoots.has(entry.path)) continue; // never descend a locked subtree
                yield { name: `${archivePath}/`, kind: "dir", size: 0n, mtime: entry.modifiedAt };
                queue.push({ path: entry.path, archive: archivePath });
            } else if (entry.kind === "file") {
                const filePath = entry.path;
                yield { name: archivePath, kind: "file", size: entry.size, mtime: entry.modifiedAt, body: () => driver.readStream(filePath) };
            }
        }
    }
}

/** Zip sources for several paths. The caller owns the driver's lifecycle. */
export async function* zipSourcesFor(
    driver: StorageDriver,
    paths: string[],
    lockedRoots: Set<string>
): AsyncGenerator<ZipSource> {
    for (const root of paths) {
        yield* walk(driver, root, lockedRoots);
    }
}

/**
 * Build a zip from `sources` and write it to `destPath` on the driver. When a
 * password is given the archive is AES-256 encrypted; otherwise it is a store-only
 * stream. Streams throughout - a large bundle is never fully buffered in memory.
 */
export async function writeArchiveToDriver(
    driver: StorageDriver,
    destPath: string,
    sources: AsyncGenerator<ZipSource>,
    options: { password?: string } = {}
): Promise<void> {
    if (!options.password) {
        await driver.writeStream(destPath, createZipStream(sources), { mime: "application/zip" });
        return;
    }

    ensureEncryptedFormat();
    // The encrypted-format options (encryptionMethod/password) are not in
    // archiver's base typings; the reshaped factory takes a loose options bag.
    const archive = archiver("zip-encrypted", {
        zlib: { level: 8 },
        encryptionMethod: "aes256",
        password: options.password
    });

    // Feed sources into the archive while the driver consumes its output stream.
    const feed = (async () => {
        for await (const source of sources) {
            if (source.kind === "file" && source.body) {
                const web = await source.body();
                archive.append(Readable.fromWeb(web as unknown as NodeWebReadableStream), { name: source.name });
            }
            // Empty directories are implied by file paths; store-only preserves
            // them explicitly, encrypted archives omit empty dirs (acceptable).
        }
        await archive.finalize();
    })();

    const output = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;
    await driver.writeStream(destPath, output, { mime: "application/zip" });
    await feed; // surface any append/finalize error after the write completes
}
