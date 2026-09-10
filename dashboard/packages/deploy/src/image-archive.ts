/**
 * Reading what a `docker save` archive would load, without loading it.
 *
 * An image built on somebody's own machine arrives as a gzipped `docker save`
 * archive, and what it would create has to be known before it is accepted: a load
 * cannot be taken back, and an archive that also carries `traefik:v3` would quietly
 * replace the edge's own image. The names are in `manifest.json`, which may sit
 * anywhere in the archive (a current engine writes it last), so the archive is
 * read through once, entry by entry, keeping that one file and skipping the rest.
 * Nothing but the manifest is ever held, whatever the size of the layers.
 */

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

/** The largest manifest read; a real one is a few hundred bytes. */
const MAX_MANIFEST = 1024 * 1024;

/** The image names `manifest.json` lists, or null when it is not a manifest or
 *  names nothing. */
export function manifestTags(raw: string): string[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const tags = parsed.flatMap((entry: unknown) => {
        const listed = (entry as { RepoTags?: unknown } | null)?.RepoTags;
        return Array.isArray(listed) ? listed.filter((tag): tag is string => typeof tag === "string") : [];
    });
    return tags.length > 0 ? tags : null;
}

/** A NUL-terminated field of a tar header. */
function field(header: Buffer, start: number, length: number): string {
    const raw = header.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString("utf8");
}

/**
 * The image names a gzipped `docker save` archive would load, or null when it is
 * not one. Reads `gzipped` to the end.
 */
export async function archiveImageTags(gzipped: NodeJS.ReadableStream): Promise<string[] | null> {
    const stream = Readable.from(gzipped).pipe(createGunzip());
    let pending = Buffer.alloc(0);
    // Bytes of the current entry still to come, and whether they are kept.
    let remaining = 0;
    let padding = 0;
    let keeping: Buffer[] | null = null;
    let manifest: string | null = null;
    let zeroBlocks = 0;

    for await (const chunk of stream as AsyncIterable<Buffer>) {
        pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
        for (;;) {
            if (remaining > 0) {
                const take = Math.min(remaining, pending.length);
                if (take === 0) break;
                if (keeping) keeping.push(pending.subarray(0, take));
                pending = pending.subarray(take);
                remaining -= take;
                if (remaining > 0) break;
                if (keeping) {
                    manifest = Buffer.concat(keeping).toString("utf8");
                    keeping = null;
                }
            }
            if (padding > 0) {
                const take = Math.min(padding, pending.length);
                pending = pending.subarray(take);
                padding -= take;
                if (padding > 0) break;
            }
            if (pending.length < BLOCK) break;
            const header = pending.subarray(0, BLOCK);
            pending = pending.subarray(BLOCK);
            if (header.every((byte) => byte === 0)) {
                zeroBlocks += 1;
                if (zeroBlocks >= 2) break;
                continue;
            }
            zeroBlocks = 0;
            const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
            if (!Number.isFinite(size) || size < 0) return null;
            // Only a ustar header has a prefix field; an older one keeps other bytes there.
            const prefix = field(header, 257, 5) === "ustar" ? field(header, 345, 155) : "";
            const name = (prefix ? `${prefix}/` : "") + field(header, 0, 100);
            const type = String.fromCharCode(header[156] ?? 0);
            remaining = size;
            padding = (BLOCK - (size % BLOCK)) % BLOCK;
            const isManifest = (type === "0" || type === "\0") && name.replace(/^\.\//, "") === "manifest.json";
            if (isManifest) {
                if (size > MAX_MANIFEST) return null;
                keeping = [];
                if (size === 0) manifest = "";
            }
        }
        if (zeroBlocks >= 2) break;
    }
    return manifest === null ? null : manifestTags(manifest);
}
