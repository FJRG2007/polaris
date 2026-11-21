/**
 * A ZIP read from disk by its index, and rewritten without being unpacked.
 *
 * A server pack is hundreds of megabytes, so neither reading one nor cleaning
 * one may hold it in memory. The central directory at the end of the file names
 * every entry and where its bytes are; a small file is inflated on its own, and
 * a rewrite copies each kept entry's compressed bytes as they are, under a new
 * name - nothing is decompressed and compressed again.
 *
 * Zip64 is read (an archive written by a tool that always uses it is still an
 * ordinary pack) but never written: what this writes stays under 4 GiB and
 * 65535 entries, which the caller's size cap guarantees, and refuses past that.
 *
 * Server-only.
 */

import { once } from "node:events";
import { inflateRawSync } from "node:zlib";
import { open, type FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";

/** Why an archive could not be read, as a code the screen words. */
export type ZipFailure = "notZip" | "encrypted" | "method" | "tooMany" | "unsafePath";

export class ZipRefusal extends Error {
    constructor(readonly reason: ZipFailure) {
        super(`zip refused: ${reason}`);
    }
}

export interface ZipEntry {
    /** The path as stored, with backslashes turned into slashes. */
    readonly name: string;
    readonly method: number;
    readonly flags: number;
    readonly crc: number;
    readonly compressedSize: number;
    readonly size: number;
    readonly time: number;
    readonly date: number;
    readonly externalAttributes: number;
    readonly localOffset: number;
    readonly directory: boolean;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
/** No pack has this many files; an index claiming more is not one. */
const MAX_ENTRIES = 500_000;
const UTF8_FLAG = 0x800;
const DESCRIPTOR_FLAG = 0x8;
const STORED = 0;
const DEFLATED = 8;

async function readAt(file: FileHandle, offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
}

/** A stored path, made relative and forward-slashed, or null when it climbs out
 *  of wherever it is extracted - an absolute path, a drive, or a `..` part. */
export function safeEntryName(raw: string): string | null {
    const name = raw.replace(/\\/g, "/");
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\0")) return null;
    if (name.split("/").some((part) => part === "..")) return null;
    return name;
}

function zip64Values(
    extra: Buffer,
    wanted: { size: boolean; compressed: boolean; offset: boolean }
): { size?: number; compressed?: number; offset?: number } {
    let at = 0;
    while (at + 4 <= extra.length) {
        const id = extra.readUInt16LE(at);
        const length = extra.readUInt16LE(at + 2);
        if (id === 0x0001) {
            let field = at + 4;
            const out: { size?: number; compressed?: number; offset?: number } = {};
            const take = () => {
                const value = Number(extra.readBigUInt64LE(field));
                field += 8;
                return value;
            };
            if (wanted.size && field + 8 <= at + 4 + length) out.size = take();
            if (wanted.compressed && field + 8 <= at + 4 + length) out.compressed = take();
            if (wanted.offset && field + 8 <= at + 4 + length) out.offset = take();
            return out;
        }
        at += 4 + length;
    }
    return {};
}

/** Every entry of the archive at `location`, from its central directory. */
export async function readZipIndex(location: string): Promise<ZipEntry[]> {
    const file = await open(location, "r");
    try {
        const { size } = await file.stat();
        const tailLength = Math.min(size, 22 + MAX_COMMENT + 20);
        const tail = await readAt(file, size - tailLength, tailLength);
        let end = -1;
        for (let at = tail.length - 22; at >= 0; at -= 1) {
            if (tail.readUInt32LE(at) === EOCD) {
                end = at;
                break;
            }
        }
        if (end < 0) throw new ZipRefusal("notZip");
        let count = tail.readUInt16LE(end + 10);
        let directorySize = tail.readUInt32LE(end + 12);
        let directoryOffset = tail.readUInt32LE(end + 16);
        if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
            const locator = end - 20;
            if (locator < 0 || tail.readUInt32LE(locator) !== EOCD64_LOCATOR)
                throw new ZipRefusal("notZip");
            const record = await readAt(file, Number(tail.readBigUInt64LE(locator + 8)), 56);
            if (record.length < 56 || record.readUInt32LE(0) !== EOCD64)
                throw new ZipRefusal("notZip");
            count = Number(record.readBigUInt64LE(32));
            directorySize = Number(record.readBigUInt64LE(40));
            directoryOffset = Number(record.readBigUInt64LE(48));
        }
        if (count > MAX_ENTRIES) throw new ZipRefusal("tooMany");
        if (directoryOffset + directorySize > size) throw new ZipRefusal("notZip");

        const directory = await readAt(file, directoryOffset, directorySize);
        const entries: ZipEntry[] = [];
        let at = 0;
        for (let index = 0; index < count; index += 1) {
            if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
                throw new ZipRefusal("notZip");
            const flags = directory.readUInt16LE(at + 8);
            const method = directory.readUInt16LE(at + 10);
            const nameLength = directory.readUInt16LE(at + 28);
            const extraLength = directory.readUInt16LE(at + 30);
            const commentLength = directory.readUInt16LE(at + 32);
            const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
            const extra = directory.subarray(
                at + 46 + nameLength,
                at + 46 + nameLength + extraLength
            );
            let compressedSize = directory.readUInt32LE(at + 20);
            let entrySize = directory.readUInt32LE(at + 24);
            let localOffset = directory.readUInt32LE(at + 42);
            const big = zip64Values(extra, {
                size: entrySize === 0xffffffff,
                compressed: compressedSize === 0xffffffff,
                offset: localOffset === 0xffffffff
            });
            entrySize = big.size ?? entrySize;
            compressedSize = big.compressed ?? compressedSize;
            localOffset = big.offset ?? localOffset;
            // Not UTF-8 is CP437 by the format, and every pack seen spells its
            // paths in ASCII, where the two agree.
            const raw = nameBytes.toString(flags & UTF8_FLAG ? "utf8" : "latin1");
            const name = safeEntryName(raw);
            if (name === null) throw new ZipRefusal("unsafePath");
            const directoryEntry = name.endsWith("/");
            if (!directoryEntry && flags & 0x1) throw new ZipRefusal("encrypted");
            if (!directoryEntry && method !== STORED && method !== DEFLATED)
                throw new ZipRefusal("method");
            entries.push({
                name,
                method,
                flags,
                crc: directory.readUInt32LE(at + 16),
                compressedSize,
                size: entrySize,
                time: directory.readUInt16LE(at + 12),
                date: directory.readUInt16LE(at + 14),
                externalAttributes: directory.readUInt32LE(at + 38),
                localOffset,
                directory: directoryEntry
            });
            at += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    } finally {
        await file.close();
    }
}

/** Where an entry's compressed bytes start: past its local header, whose name
 *  and extra field may differ in length from the central directory's. */
async function dataOffset(file: FileHandle, entry: ZipEntry): Promise<number> {
    const header = await readAt(file, entry.localOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new ZipRefusal("notZip");
    return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/** One small entry's contents, or null when it is larger than `limit`. */
export async function readZipText(
    location: string,
    entry: ZipEntry,
    limit = 1024 * 1024
): Promise<string | null> {
    if (entry.directory || entry.size > limit || entry.compressedSize > limit) return null;
    const file = await open(location, "r");
    try {
        const start = await dataOffset(file, entry);
        const raw = await readAt(file, start, entry.compressedSize);
        const bytes =
            entry.method === STORED
                ? raw
                : inflateRawSync(raw, { maxOutputLength: Math.max(limit, 1) });
        return bytes.toString("utf8");
    } catch {
        return null;
    } finally {
        await file.close();
    }
}

/** What a rewrite keeps: an entry of the source and the name it is stored under. */
export interface KeptEntry {
    readonly entry: ZipEntry;
    readonly name: string;
}

const MAX_WRITE_ENTRIES = 0xffff;
const MAX_WRITE_BYTES = 0xffffffff;

/**
 * A new archive at `target` holding `kept`, each entry's compressed bytes copied
 * from `source` as they are. Returns its size. The data descriptor flag is
 * dropped, because the sizes are known and written into the local header.
 */
export async function rewriteZip(
    source: string,
    target: string,
    kept: readonly KeptEntry[],
    onProgress?: (written: number) => void
): Promise<number> {
    if (kept.length > MAX_WRITE_ENTRIES) throw new ZipRefusal("tooMany");
    const input = await open(source, "r");
    const output = createWriteStream(target, { flags: "wx" });
    const write = async (chunk: Buffer) => {
        if (!output.write(chunk)) await once(output, "drain");
    };
    const central: Buffer[] = [];
    let offset = 0;
    try {
        for (const { entry, name } of kept) {
            const nameBytes = Buffer.from(name, "utf8");
            const flags = (entry.flags & ~DESCRIPTOR_FLAG & ~0x1) | UTF8_FLAG;
            const local = Buffer.alloc(30);
            local.writeUInt32LE(LOCAL, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(flags, 6);
            local.writeUInt16LE(entry.directory ? STORED : entry.method, 8);
            local.writeUInt16LE(entry.time, 10);
            local.writeUInt16LE(entry.date, 12);
            local.writeUInt32LE(entry.directory ? 0 : entry.crc, 14);
            local.writeUInt32LE(entry.directory ? 0 : entry.compressedSize, 18);
            local.writeUInt32LE(entry.directory ? 0 : entry.size, 22);
            local.writeUInt16LE(nameBytes.length, 26);
            local.writeUInt16LE(0, 28);
            const headerOffset = offset;
            await write(local);
            await write(nameBytes);
            offset += 30 + nameBytes.length;
            if (!entry.directory && entry.compressedSize > 0) {
                const start = await dataOffset(input, entry);
                const stream = createReadStream("", {
                    fd: input.fd,
                    autoClose: false,
                    start,
                    end: start + entry.compressedSize - 1
                });
                for await (const piece of stream) await write(piece as Buffer);
                offset += entry.compressedSize;
                onProgress?.(offset);
            }
            if (offset > MAX_WRITE_BYTES) throw new ZipRefusal("tooMany");

            const record = Buffer.alloc(46);
            record.writeUInt32LE(CENTRAL, 0);
            record.writeUInt16LE(0x031e, 4);
            record.writeUInt16LE(20, 6);
            record.writeUInt16LE(flags, 8);
            record.writeUInt16LE(entry.directory ? STORED : entry.method, 10);
            record.writeUInt16LE(entry.time, 12);
            record.writeUInt16LE(entry.date, 14);
            record.writeUInt32LE(entry.directory ? 0 : entry.crc, 16);
            record.writeUInt32LE(entry.directory ? 0 : entry.compressedSize, 20);
            record.writeUInt32LE(entry.directory ? 0 : entry.size, 24);
            record.writeUInt16LE(nameBytes.length, 28);
            record.writeUInt32LE(entry.externalAttributes >>> 0, 38);
            record.writeUInt32LE(headerOffset, 42);
            central.push(record, nameBytes);
        }
        const directory = Buffer.concat(central);
        if (offset + directory.length > MAX_WRITE_BYTES) throw new ZipRefusal("tooMany");
        const end = Buffer.alloc(22);
        end.writeUInt32LE(EOCD, 0);
        end.writeUInt16LE(kept.length, 8);
        end.writeUInt16LE(kept.length, 10);
        end.writeUInt32LE(directory.length, 12);
        end.writeUInt32LE(offset, 16);
        await write(directory);
        await write(end);
        output.end();
        await once(output, "close");
        return offset + directory.length + end.length;
    } catch (error) {
        output.destroy();
        throw error;
    } finally {
        await input.close();
    }
}
