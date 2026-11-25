/**
 * The `FileDescription` a Windows executable carries in its version resource
 * ("Notepad++ : a free (GNU) source code editor", "Google Chrome") - what
 * Explorer shows as the file's description. A program somebody installed has
 * one; a nameless executable is almost always a helper binary, which is how
 * the `App Paths` source tells the two apart (Vicinae's `scanAppPaths`).
 *
 * Read from the PE headers and the resource section with small positional
 * reads, never the whole file, and every offset checked against the file's
 * size: a truncated or hostile executable yields null, never a throw or a huge
 * read. Nothing is run.
 */

import { open } from "node:fs/promises";

/** A positional read: up to `length` bytes at `offset`, fewer at the end of the file. */
export type ReadAt = (offset: number, length: number) => Promise<Buffer>;

/** The most bytes of a version resource read: real ones are a few KiB. */
const MAX_VERSION_BYTES = 64 * 1024;
const MAX_SECTIONS = 96;
const RT_VERSION = 16;

async function u16(read: ReadAt, offset: number): Promise<number | null> {
    const bytes = await read(offset, 2);
    return bytes.length === 2 ? bytes.readUInt16LE(0) : null;
}

async function u32(read: ReadAt, offset: number): Promise<number | null> {
    const bytes = await read(offset, 4);
    return bytes.length === 4 ? bytes.readUInt32LE(0) : null;
}

interface Section {
    readonly address: number;
    readonly size: number;
    readonly raw: number;
}

/** The first entry of a resource directory, or the one with this numeric id. */
async function directoryEntry(read: ReadAt, base: number, at: number, id?: number): Promise<number | null> {
    const named = await u16(read, base + at + 12);
    const ids = await u16(read, base + at + 14);
    if (named === null || ids === null) return null;
    const count = Math.min(named + ids, 256);
    for (let index = id === undefined ? 0 : named; index < count; index++) {
        const entry = base + at + 16 + index * 8;
        const name = await u32(read, entry);
        const target = await u32(read, entry + 4);
        if (name === null || target === null) return null;
        if (id === undefined || name === id) return target;
    }
    return null;
}

/** The `FileDescription` value inside a `VS_VERSIONINFO` block, or null. */
export function versionDescription(block: Buffer): string | null {
    const key = Buffer.from("FileDescription\0", "utf16le");
    let at = block.indexOf(key);
    while (at >= 0 && at % 2 !== 0) at = block.indexOf(key, at + 1);
    if (at < 6) return null;
    const words = block.readUInt16LE(at - 4);
    const start = (at + key.length + 3) & ~3;
    const end = Math.min(block.length, start + words * 2);
    if (words === 0 || start >= end) return null;
    const text = block.subarray(start, end - ((end - start) % 2)).toString("utf16le").replace(/\0+$/, "").trim();
    return text.length > 0 && text.length <= 260 ? text : null;
}

/** The description of the executable `read` reads, or null when it has none or is not one. */
export async function exeDescriptionFrom(read: ReadAt): Promise<string | null> {
    const header = await read(0, 64);
    if (header.length < 64 || header.toString("latin1", 0, 2) !== "MZ") return null;
    const pe = header.readUInt32LE(0x3c);
    const signature = await read(pe, 4);
    if (signature.toString("latin1") !== "PE\0\0") return null;
    const sections = await u16(read, pe + 6);
    const optionalSize = await u16(read, pe + 20);
    const optional = pe + 24;
    const magic = await u16(read, optional);
    if (sections === null || optionalSize === null || magic === null || sections > MAX_SECTIONS) return null;
    const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
    if (Number.isNaN(directories)) return null;
    const resourceRva = await u32(read, directories + 2 * 8);
    if (!resourceRva) return null;
    const table: Section[] = [];
    for (let index = 0; index < sections; index++) {
        const at = optional + optionalSize + index * 40;
        const size = await u32(read, at + 8);
        const address = await u32(read, at + 12);
        const rawSize = await u32(read, at + 16);
        const raw = await u32(read, at + 20);
        if (size === null || address === null || rawSize === null || raw === null) return null;
        table.push({ address, size: Math.max(size, rawSize), raw });
    }
    const fileOffset = (rva: number): number | null => {
        const section = table.find((candidate) => rva >= candidate.address && rva < candidate.address + candidate.size);
        return section ? rva - section.address + section.raw : null;
    };
    const base = fileOffset(resourceRva);
    if (base === null) return null;
    // Type -> name -> language: the version resource's first name and first language.
    const type = await directoryEntry(read, base, 0, RT_VERSION);
    if (type === null || !(type & 0x80000000)) return null;
    const name = await directoryEntry(read, base, type & 0x7fffffff);
    if (name === null || !(name & 0x80000000)) return null;
    const language = await directoryEntry(read, base, name & 0x7fffffff);
    if (language === null || language & 0x80000000) return null;
    const dataRva = await u32(read, base + language);
    const dataSize = await u32(read, base + language + 4);
    const data = dataRva === null ? null : fileOffset(dataRva);
    if (data === null || !dataSize) return null;
    return versionDescription(await read(data, Math.min(dataSize, MAX_VERSION_BYTES)));
}

/** The description of the executable at `path`, or null when it has none or cannot be read. */
export async function exeDescription(path: string): Promise<string | null> {
    const handle = await open(path, "r").catch(() => null);
    if (!handle) return null;
    try {
        const read: ReadAt = async (offset, length) => {
            if (offset < 0 || length <= 0 || !Number.isSafeInteger(offset)) return Buffer.alloc(0);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
        };
        return await exeDescriptionFrom(read);
    } catch {
        return null;
    } finally {
        await handle.close().catch(() => undefined);
    }
}
