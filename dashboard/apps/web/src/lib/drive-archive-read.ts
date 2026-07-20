/**
 * Reading side of Drive archives: list an archive's entries (for preview) and
 * extract it into a folder on the NAS. Supports zip (node-stream-zip) and rar
 * (node-unrar-js, WASM; extract/list only - rar cannot be created).
 *
 * Both readers need random access, so the archive is first streamed to a private
 * temp file rather than held in memory, and removed afterwards. Extraction treats
 * every entry as hostile:
 *   - Zip-slip: an entry name is confined under the destination; any `..`,
 *     absolute, or drive-prefixed component aborts the whole extraction.
 *   - Decompression bombs: total extracted bytes and entry count are capped.
 * The archive password (when given) is never logged.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import StreamZip from "node-stream-zip";
import { createExtractorFromData } from "node-unrar-js";
import { normalizeRelPath } from "@polaris/core";
import type { StorageDriver } from "@polaris/storage";

export type ArchiveFormat = "zip" | "rar";

/** Detect a supported archive format from a filename, or null. */
export function archiveFormatOf(name: string): ArchiveFormat | null {
    const lower = name.toLowerCase();
    if (lower.endsWith(".zip")) return "zip";
    if (lower.endsWith(".rar")) return "rar";
    return null;
}

export interface ArchiveEntry {
    readonly name: string;
    readonly size: number;
    readonly isDirectory: boolean;
}

/** Caps that bound an extraction so a malicious archive cannot exhaust the host. */
const MAX_ENTRIES = 20000;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB uncompressed, aggregate

/** Stream the archive to a private temp file and return its path. */
async function toTempFile(driver: StorageDriver, path: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "polaris-archive-"));
    const file = join(dir, "archive");
    const web = await driver.readStream(path);
    await pipeline(Readable.fromWeb(web as never), createWriteStream(file));
    return file;
}

/** List an archive's entries without extracting. Names only need no password for
 *  zip; rar listing of an encrypted archive needs the password. */
export async function listArchiveEntries(
    driver: StorageDriver,
    path: string,
    format: ArchiveFormat,
    password?: string
): Promise<ArchiveEntry[]> {
    const file = await toTempFile(driver, path);
    try {
        if (format === "zip") {
            const zip = new StreamZip.async({ file });
            try {
                const entries = await zip.entries();
                return Object.values(entries).map((entry) => ({
                    name: entry.name,
                    size: entry.size,
                    isDirectory: entry.isDirectory
                }));
            } finally {
                await zip.close();
            }
        }
        const data = await readFile(file);
        const extractor = await createExtractorFromData({ data, password });
        const list = extractor.getFileList();
        const out: ArchiveEntry[] = [];
        for (const header of list.fileHeaders) {
            out.push({ name: header.name, size: header.unpSize, isDirectory: header.flags.directory });
        }
        return out;
    } finally {
        await rm(file, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Resolve an archive entry name to a driver-relative path confined under
 *  `destFolder`. Throws on any traversal/absolute component (zip-slip). */
function safeEntryPath(destFolder: string, entryName: string): string {
    // normalizeRelPath rejects/normalizes; then verify no upward escape remains.
    const rel = normalizeRelPath(entryName.replace(/\\/g, "/"));
    if (rel === "" || rel.split("/").some((seg) => seg === "..")) {
        throw new Error(`Unsafe archive entry: ${entryName}`);
    }
    return destFolder ? `${destFolder}/${rel}` : rel;
}

/**
 * Extract the archive into `destFolder` on the driver, enforcing zip-slip and
 * decompression-bomb guards. Directories are created as needed; each file streams
 * to the driver. Returns the number of files written.
 */
export async function extractArchiveTo(
    driver: StorageDriver,
    archivePath: string,
    format: ArchiveFormat,
    destFolder: string,
    password: string | undefined
): Promise<number> {
    const file = await toTempFile(driver, archivePath);
    let written = 0;
    let totalBytes = 0;
    const dest = normalizeRelPath(destFolder);
    const ensureDir = async (relDir: string) => {
        if (relDir) await driver.mkdir(relDir);
    };
    const parentOf = (rel: string) => rel.split("/").slice(0, -1).join("/");

    try {
        if (format === "zip") {
            const zip = new StreamZip.async({ file });
            try {
                const entries = Object.values(await zip.entries());
                if (entries.length > MAX_ENTRIES) throw new Error("Archive has too many entries");
                for (const entry of entries) {
                    const target = safeEntryPath(dest, entry.name);
                    if (entry.isDirectory) {
                        await ensureDir(target);
                        continue;
                    }
                    totalBytes += entry.size;
                    if (++written > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
                        throw new Error("Archive exceeds the extraction limit");
                    }
                    await ensureDir(parentOf(target));
                    const stream = await zip.stream(entry.name);
                    await driver.writeStream(target, Readable.toWeb(stream as unknown as Readable) as never);
                }
            } finally {
                await zip.close();
            }
            return written;
        }

        const data = await readFile(file);
        const extractor = await createExtractorFromData({ data, password });
        const extracted = extractor.extract();
        for (const extractedFile of extracted.files) {
            const header = extractedFile.fileHeader;
            const target = safeEntryPath(dest, header.name);
            if (header.flags.directory) {
                await ensureDir(target);
                continue;
            }
            totalBytes += header.unpSize;
            if (++written > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
                throw new Error("Archive exceeds the extraction limit");
            }
            await ensureDir(parentOf(target));
            const content = extractedFile.extraction;
            if (!content) continue; // header-only pass yields no bytes for this entry
            await driver.writeStream(target, Readable.toWeb(Readable.from(Buffer.from(content))) as never);
        }
        return written;
    } finally {
        await rm(file, { recursive: true, force: true }).catch(() => undefined);
    }
}
