/**
 * Minimal streaming ZIP writer (store method, no compression). Given an async
 * sequence of files, it emits a valid ZIP as a web ReadableStream without ever
 * holding a whole file in memory - each file's bytes stream straight through
 * while a running CRC-32 is computed, so multi-gigabyte downloads never buffer.
 *
 * Why hand-rolled: the only thing needed is "bundle these streams into one
 * download", and the store-only format is small and fully specified. This avoids
 * a compression dependency and keeps the archive path under our control. ZIP64
 * fields kick in automatically for files or archives past the 4 GiB / 65535-entry
 * limits, so large NAS files are handled correctly.
 *
 * Compression is intentionally omitted: these are arbitrary NAS files (often
 * already-compressed media), the bytes stream from a remote driver, and storing
 * keeps CPU flat while still solving the real problem (one file, many items).
 */

/** A single file to place in the archive. `size` is the expected byte length. */
export interface ZipFile {
    /** Path inside the archive, using forward slashes. */
    name: string;
    /** Expected size in bytes (from stat); used to pick 32- vs 64-bit fields. */
    size: number;
    /** Opens the file's byte stream. Called once, lazily, when it is its turn. */
    open: () => Promise<ReadableStream<Uint8Array>>;
}

const LOCAL_SIG = 0x04034b50;
const DATA_DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const U32_MAX = 0xffffffff;
/** General-purpose flags: bit 3 (data descriptor) + bit 11 (UTF-8 names). */
const GP_FLAGS = 0x0808;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** Running CRC-32; start at 0, feed chunks, then finalize. */
function crcUpdate(crc: number, bytes: Uint8Array): number {
    let value = crc ^ U32_MAX;
    for (let i = 0; i < bytes.length; i++) value = (value >>> 8) ^ CRC_TABLE[(value ^ bytes[i]!) & 0xff]!;
    return (value ^ U32_MAX) >>> 0;
}

/** One entry's bookkeeping, captured while streaming, used for the central dir. */
interface CentralEntry {
    name: Uint8Array;
    crc: number;
    size: bigint;
    offset: bigint;
}

/** Build a Zip64 extended-information extra field carrying the given 8-byte values. */
function zip64Extra(values: bigint[]): Buffer {
    const buffer = Buffer.alloc(4 + values.length * 8);
    buffer.writeUInt16LE(0x0001, 0);
    buffer.writeUInt16LE(values.length * 8, 2);
    values.forEach((value, index) => buffer.writeBigUInt64LE(value, 4 + index * 8));
    return buffer;
}

function localHeader(name: Uint8Array, size: number): Buffer {
    const zip64 = size >= U32_MAX;
    const extra = zip64 ? zip64Extra([0n, 0n]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(GP_FLAGS, 6);
    header.writeUInt16LE(0, 8); // store
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    header.writeUInt32LE(0, 14); // crc (in data descriptor)
    header.writeUInt32LE(zip64 ? U32_MAX : 0, 18); // compressed size
    header.writeUInt32LE(zip64 ? U32_MAX : 0, 22); // uncompressed size
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    return Buffer.concat([header, Buffer.from(name), extra]);
}

/** Data descriptor after an entry's bytes (zip64 form uses 8-byte sizes). */
function dataDescriptor(crc: number, size: bigint, zip64: boolean): Buffer {
    if (zip64) {
        const buffer = Buffer.alloc(24);
        buffer.writeUInt32LE(DATA_DESC_SIG, 0);
        buffer.writeUInt32LE(crc >>> 0, 4);
        buffer.writeBigUInt64LE(size, 8);
        buffer.writeBigUInt64LE(size, 16);
        return buffer;
    }
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(DATA_DESC_SIG, 0);
    buffer.writeUInt32LE(crc >>> 0, 4);
    buffer.writeUInt32LE(Number(size), 8);
    buffer.writeUInt32LE(Number(size), 12);
    return buffer;
}

function centralHeader(entry: CentralEntry): Buffer {
    const needsZip64 = entry.size >= BigInt(U32_MAX) || entry.offset >= BigInt(U32_MAX);
    const extra = needsZip64 ? zip64Extra([entry.size, entry.size, entry.offset]) : Buffer.alloc(0);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(45, 4); // version made by
    header.writeUInt16LE(needsZip64 ? 45 : 20, 6);
    header.writeUInt16LE(GP_FLAGS, 8);
    header.writeUInt16LE(0, 10); // store
    header.writeUInt16LE(0, 12); // mod time
    header.writeUInt16LE(0x21, 14); // mod date
    header.writeUInt32LE(entry.crc >>> 0, 16);
    header.writeUInt32LE(needsZip64 ? U32_MAX : Number(entry.size), 20);
    header.writeUInt32LE(needsZip64 ? U32_MAX : Number(entry.size), 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(needsZip64 ? U32_MAX : Number(entry.offset), 42);
    return Buffer.concat([header, Buffer.from(entry.name), extra]);
}

/** End-of-central-directory records (with Zip64 pair when anything overflows). */
function endRecords(entries: CentralEntry[], centralOffset: bigint, centralSize: bigint): Buffer {
    const count = entries.length;
    const needsZip64 =
        centralOffset >= BigInt(U32_MAX) || centralSize >= BigInt(U32_MAX) || count >= 0xffff;

    const parts: Buffer[] = [];
    if (needsZip64) {
        const zip64Eocd = Buffer.alloc(56);
        zip64Eocd.writeUInt32LE(ZIP64_EOCD_SIG, 0);
        zip64Eocd.writeBigUInt64LE(44n, 4); // size of remainder
        zip64Eocd.writeUInt16LE(45, 12); // version made by
        zip64Eocd.writeUInt16LE(45, 14); // version needed
        zip64Eocd.writeUInt32LE(0, 16); // disk
        zip64Eocd.writeUInt32LE(0, 20); // disk with cd
        zip64Eocd.writeBigUInt64LE(BigInt(count), 24);
        zip64Eocd.writeBigUInt64LE(BigInt(count), 32);
        zip64Eocd.writeBigUInt64LE(centralSize, 40);
        zip64Eocd.writeBigUInt64LE(centralOffset, 48);

        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
        locator.writeUInt32LE(0, 4); // disk with zip64 eocd
        locator.writeBigUInt64LE(centralOffset + centralSize, 8); // offset of zip64 eocd
        locator.writeUInt32LE(1, 16); // total disks
        parts.push(zip64Eocd, locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // disk with cd
    eocd.writeUInt16LE(count >= 0xffff ? 0xffff : count, 8);
    eocd.writeUInt16LE(count >= 0xffff ? 0xffff : count, 10);
    eocd.writeUInt32LE(centralSize >= BigInt(U32_MAX) ? U32_MAX : Number(centralSize), 12);
    eocd.writeUInt32LE(centralOffset >= BigInt(U32_MAX) ? U32_MAX : Number(centralOffset), 16);
    eocd.writeUInt16LE(0, 20); // comment length
    parts.push(eocd);
    return Buffer.concat(parts);
}

/**
 * Stream the given files as one ZIP. Files are consumed lazily and in order; a
 * file whose stream errors mid-way aborts the whole archive (a partial ZIP is
 * never silently produced). Returns a web ReadableStream of the archive bytes.
 */
export function createZipStream(files: AsyncIterable<ZipFile>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    async function* generate(): AsyncGenerator<Uint8Array> {
        const central: CentralEntry[] = [];
        let offset = 0n;

        for await (const file of files) {
            const name = encoder.encode(file.name);
            const header = localHeader(name, file.size);
            yield header;
            const startOffset = offset;
            offset += BigInt(header.length);

            let crc = 0;
            let written = 0n;
            const stream = await file.open();
            const reader = stream.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                crc = crcUpdate(crc, value);
                written += BigInt(value.length);
                yield value;
            }
            offset += written;

            const zip64Local = file.size >= U32_MAX;
            const descriptor = dataDescriptor(crc, written, zip64Local);
            yield descriptor;
            offset += BigInt(descriptor.length);

            central.push({ name, crc, size: written, offset: startOffset });
        }

        const centralOffset = offset;
        let centralSize = 0n;
        for (const entry of central) {
            const header = centralHeader(entry);
            centralSize += BigInt(header.length);
            yield header;
        }
        yield endRecords(central, centralOffset, centralSize);
    }

    const iterator = generate();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await iterator.next();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel() {
            await iterator.return?.(undefined);
        }
    });
}
