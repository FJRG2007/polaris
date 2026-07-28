/**
 * Tells whether an archive is password-protected, so the browser can mark it
 * before someone downloads it and finds out the hard way.
 *
 * Only the first bytes of the file are read. A zip's authoritative answer lives
 * in the central directory at the very end, but the first local file header
 * carries the same encryption bit, and reading the tail would mean pulling the
 * whole archive across the wire on backends without ranged reads (SMB). So the
 * head is what is parsed: the first entry of a protected zip is protected in
 * every tool that writes them. Rar states it up front by design - rar4 in the
 * archive and file header flags, rar5 either as an encryption block or as an
 * encryption record in the file header's extra area.
 *
 * Anything unrecognized (7z, a truncated head, a format quirk) returns null -
 * "cannot tell" - which the UI shows as no badge at all. It never guesses:
 * claiming an archive is locked when it is not would be worse than staying quiet.
 */

import type { StorageDriver } from "@polaris/storage";

/** Bytes pulled from the start of an archive; comfortably covers the headers. */
const HEAD_BYTES = 64 * 1024;

/** Archives worth probing (the formats whose head states it plainly). */
export function isProbableArchive(name: string): boolean {
    return /\.(zip|rar)$/i.test(name);
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

function startsWith(data: Uint8Array, signature: number[]): boolean {
    if (data.length < signature.length) return false;
    return signature.every((byte, index) => data[index] === byte);
}

/** Zip: bit 0 of the first local file header's general purpose flags. */
function zipEncrypted(view: DataView): boolean | null {
    if (view.byteLength < 8) return null;
    if (view.getUint32(0, true) !== ZIP_LOCAL_HEADER) return null;
    const flags = view.getUint16(6, true);
    // Bit 0 marks a protected entry (both legacy ZipCrypto and WinZip AES set it).
    return (flags & 0x0001) !== 0;
}

/**
 * Rar4: a chain of blocks, each `crc(2) type(1) flags(2) size(2)`. The archive
 * header (0x73) sets 0x0080 when the headers themselves are encrypted; a file
 * header (0x74) sets 0x0004 when its contents are.
 */
function rar4Encrypted(view: DataView): boolean | null {
    let offset = RAR4_SIGNATURE.length;
    while (offset + 7 <= view.byteLength) {
        const type = view.getUint8(offset + 2);
        const flags = view.getUint16(offset + 3, true);
        const size = view.getUint16(offset + 5, true);
        if (size < 7) return null;
        if (type === 0x73 && (flags & 0x0080) !== 0) return true;
        if (type === 0x74) return (flags & 0x0004) !== 0;
        // A block carrying data announces it in an extra 32-bit field (flag 0x8000).
        const added =
            (flags & 0x8000) !== 0 && offset + 11 <= view.byteLength
                ? view.getUint32(offset + 7, true)
                : 0;
        offset += size + added;
    }
    return null;
}

/** Rar5 variable-length integer: 7 bits per byte, high bit continues. */
function readVint(view: DataView, offset: number): { value: number; next: number } | null {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < view.byteLength && shift <= 56) {
        const byte = view.getUint8(cursor++);
        value += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) return { value, next: cursor };
        shift += 7;
    }
    return null;
}

/**
 * Rar5: blocks are `crc(4) vint(size) vint(type) ...`. Type 4 is the encryption
 * header, which only exists when the archive headers are encrypted. Otherwise a
 * file header (type 2) declares per-file encryption with record type 1 in its
 * extra area, so that area is what gets walked.
 */
function rar5Encrypted(view: DataView): boolean | null {
    let offset = RAR5_SIGNATURE.length;
    // Bounded: the head holds the first blocks, which is where the answer is.
    for (let block = 0; block < 64; block++) {
        if (offset + 4 >= view.byteLength) return null;
        const sizeField = readVint(view, offset + 4);
        if (!sizeField) return null;
        const typeField = readVint(view, sizeField.next);
        if (!typeField) return null;
        if (typeField.value === 4) return true;

        const headerEnd = sizeField.next + sizeField.value;
        if (typeField.value === 2) return rar5FileEncrypted(view, typeField.next, headerEnd);

        const flagsField = readVint(view, typeField.next);
        if (!flagsField) return null;
        let cursor = flagsField.next;
        // The extra area is counted inside the header size; the data area follows
        // it, so its length has to be read to find where the next block starts.
        if ((flagsField.value & 0x0001) !== 0) {
            const extra = readVint(view, cursor);
            if (!extra) return null;
            cursor = extra.next;
        }
        let dataSize = 0;
        if ((flagsField.value & 0x0002) !== 0) {
            const data = readVint(view, cursor);
            if (!data) return null;
            dataSize = data.value;
        }
        offset = headerEnd + dataSize;
        if (offset <= sizeField.next) return null;
    }
    return null;
}

/** Whether a rar5 file header carries an encryption record in its extra area. */
function rar5FileEncrypted(view: DataView, offset: number, headerEnd: number): boolean | null {
    const flagsField = readVint(view, offset);
    if (!flagsField) return null;
    if ((flagsField.value & 0x0001) === 0) return false; // no extra area, so no encryption record
    const extraField = readVint(view, flagsField.next);
    if (!extraField) return null;
    let cursor = extraField.next;
    if ((flagsField.value & 0x0002) !== 0) {
        const dataField = readVint(view, cursor);
        if (!dataField) return null;
        cursor = dataField.next;
    }
    // Skip the fixed file fields to reach the name, then the extra area.
    const fileFlags = readVint(view, cursor);
    if (!fileFlags) return null;
    const unpackedSize = readVint(view, fileFlags.next);
    if (!unpackedSize) return null;
    const attributes = readVint(view, unpackedSize.next);
    if (!attributes) return null;
    cursor = attributes.next;
    if ((fileFlags.value & 0x0002) !== 0) cursor += 4; // modification time
    if ((fileFlags.value & 0x0004) !== 0) cursor += 4; // data crc32
    const compression = readVint(view, cursor);
    if (!compression) return null;
    const hostOs = readVint(view, compression.next);
    if (!hostOs) return null;
    const nameLength = readVint(view, hostOs.next);
    if (!nameLength) return null;

    let record = nameLength.next + nameLength.value;
    const extraEnd = Math.min(headerEnd, view.byteLength);
    while (record < extraEnd) {
        const size = readVint(view, record);
        if (!size || size.value <= 0) return null;
        const type = readVint(view, size.next);
        if (!type) return null;
        if (type.value === 1) return true;
        record = size.next + size.value;
    }
    return false;
}

/** Read the encryption state out of an archive's first bytes ("null" = unknown). */
export function detectEncryptionFromHead(head: Uint8Array): boolean | null {
    if (head.length < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (startsWith(head, RAR5_SIGNATURE)) return rar5Encrypted(view);
    if (startsWith(head, RAR4_SIGNATURE)) return rar4Encrypted(view);
    return zipEncrypted(view);
}

/** Pull the first bytes of a file, closing the stream as soon as they are in. */
async function readHead(driver: StorageDriver, path: string, bytes: number): Promise<Uint8Array> {
    const stream = await driver.readStream(path, { start: 0, end: bytes - 1 });
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < bytes) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            chunks.push(value);
            total += value.length;
        }
    } finally {
        // Backends without ranged reads stream the whole file; stop them early.
        await reader.cancel().catch(() => undefined);
    }
    const head = new Uint8Array(Math.min(total, bytes));
    let offset = 0;
    for (const chunk of chunks) {
        if (offset >= head.length) break;
        const slice = chunk.subarray(0, head.length - offset);
        head.set(slice, offset);
        offset += slice.length;
    }
    return head;
}

/** Cached answers, keyed by the file identity that would change the answer. */
const cache = new Map<string, boolean | null>();
const CACHE_LIMIT = 2000;

function cacheKey(connectionId: string, path: string, size: bigint, modifiedAt: Date): string {
    return `${connectionId}|${path}|${size}|${modifiedAt.getTime()}`;
}

/**
 * Whether an archive is password-protected, reading (and remembering) as little
 * as possible. Returns null when the format does not say, or the read failed.
 */
export async function probeArchiveEncryption(
    driver: StorageDriver,
    connectionId: string,
    path: string,
    size: bigint,
    modifiedAt: Date
): Promise<boolean | null> {
    const key = cacheKey(connectionId, path, size, modifiedAt);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let result: boolean | null = null;
    try {
        result = detectEncryptionFromHead(await readHead(driver, path, HEAD_BYTES));
    } catch {
        result = null;
    }
    if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, result);
    return result;
}
