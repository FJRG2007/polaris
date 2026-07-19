/**
 * A dependency-free, streaming ZIP writer for bundling several stored files (and
 * whole folders) into one download. It is store-only (no compression) and emits
 * each entry with a trailing data descriptor, so file bytes stream straight from
 * the storage driver to the client without ever being buffered or read twice -
 * the CRC-32 and size are computed on the fly as bytes pass through. A correct
 * central directory (and Zip64 records when a file or the archive crosses 4 GiB)
 * is written at the end, so every mainstream extractor opens the result.
 *
 * Node runtime only (uses Buffer); the Drive download-zip route pulls sources
 * lazily from this generator so at most one file is open at a time.
 */

/** One archive member. Directories end their name with "/" and carry no body. */
export interface ZipSource {
    /** Archive-relative, "/"-separated path. A directory's name ends with "/". */
    readonly name: string;
    readonly kind: "file" | "dir";
    /** Uncompressed size in bytes (0 for directories); informational only. */
    readonly size: bigint;
    readonly mtime?: Date;
    /** Opens the file's byte stream (files only), called lazily per entry. */
    readonly body?: () => Promise<ReadableStream<Uint8Array>>;
}

const U32_MAX = 0xffffffffn;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32Update(crc: number, data: Uint8Array): number {
    let c = crc;
    for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
    return c >>> 0;
}

/** DOS date/time packing (1980 epoch, 2-second resolution). */
function dosDateTime(date?: Date): { time: number; date: number } {
    const dt = date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.max(1980, dt.getFullYear());
    const packedDate = ((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
    const packedTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
    return { time: packedTime, date: packedDate };
}

interface CentralRecord {
    nameBytes: Buffer;
    flags: number;
    time: number;
    date: number;
    crc: number;
    size: bigint;
    offset: bigint;
    zip64: boolean;
    isDir: boolean;
}

function localHeader(record: {
    nameBytes: Buffer;
    flags: number;
    time: number;
    date: number;
    zip64: boolean;
}): Buffer {
    const buf = Buffer.alloc(30 + record.nameBytes.length);
    buf.writeUInt32LE(0x04034b50, 0);
    buf.writeUInt16LE(record.zip64 ? 45 : 20, 4);
    buf.writeUInt16LE(record.flags, 6);
    buf.writeUInt16LE(0, 8); // method: store
    buf.writeUInt16LE(record.time, 10);
    buf.writeUInt16LE(record.date, 12);
    buf.writeUInt32LE(0, 14); // crc (in data descriptor)
    buf.writeUInt32LE(0, 18); // compressed size (in data descriptor)
    buf.writeUInt32LE(0, 22); // uncompressed size (in data descriptor)
    buf.writeUInt16LE(record.nameBytes.length, 26);
    buf.writeUInt16LE(0, 28); // extra length
    record.nameBytes.copy(buf, 30);
    return buf;
}

function dataDescriptor(crc: number, size: bigint, zip64: boolean): Buffer {
    if (zip64) {
        const buf = Buffer.alloc(24);
        buf.writeUInt32LE(0x08074b50, 0);
        buf.writeUInt32LE(crc >>> 0, 4);
        buf.writeBigUInt64LE(size, 8); // compressed == uncompressed (store)
        buf.writeBigUInt64LE(size, 16);
        return buf;
    }
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(0x08074b50, 0);
    buf.writeUInt32LE(crc >>> 0, 4);
    buf.writeUInt32LE(Number(size), 8);
    buf.writeUInt32LE(Number(size), 12);
    return buf;
}

function centralHeader(record: CentralRecord): Buffer {
    const extra = record.zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (record.zip64) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(record.size, 4); // uncompressed
        extra.writeBigUInt64LE(record.size, 12); // compressed
        extra.writeBigUInt64LE(record.offset, 20); // local header offset
    }
    const buf = Buffer.alloc(46 + record.nameBytes.length + extra.length);
    buf.writeUInt32LE(0x02014b50, 0);
    buf.writeUInt16LE(45, 4); // version made by
    buf.writeUInt16LE(record.zip64 ? 45 : 20, 6);
    buf.writeUInt16LE(record.flags, 8);
    buf.writeUInt16LE(0, 10); // method: store
    buf.writeUInt16LE(record.time, 12);
    buf.writeUInt16LE(record.date, 14);
    buf.writeUInt32LE(record.crc >>> 0, 16);
    buf.writeUInt32LE(record.zip64 ? 0xffffffff : Number(record.size), 20);
    buf.writeUInt32LE(record.zip64 ? 0xffffffff : Number(record.size), 24);
    buf.writeUInt16LE(record.nameBytes.length, 28);
    buf.writeUInt16LE(extra.length, 30);
    buf.writeUInt16LE(0, 32); // comment length
    buf.writeUInt16LE(0, 34); // disk number start
    buf.writeUInt16LE(0, 36); // internal attributes
    buf.writeUInt32LE(record.isDir ? 0x10 : 0, 38); // external attributes (dir bit)
    buf.writeUInt32LE(record.zip64 ? 0xffffffff : Number(record.offset), 42);
    record.nameBytes.copy(buf, 46);
    extra.copy(buf, 46 + record.nameBytes.length);
    return buf;
}

/** The end-of-archive records (Zip64 pair when the archive needs it) as one buffer. */
function endRecords(count: number, cdStart: bigint, cdSize: bigint): Buffer {
    const needZip64 = count >= 0xffff || cdStart >= U32_MAX || cdStart + cdSize >= U32_MAX;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needZip64 ? 0xffff : count, 8);
    eocd.writeUInt16LE(needZip64 ? 0xffff : count, 10);
    eocd.writeUInt32LE(cdSize >= U32_MAX ? 0xffffffff : Number(cdSize), 12);
    eocd.writeUInt32LE(cdStart >= U32_MAX ? 0xffffffff : Number(cdStart), 16);
    eocd.writeUInt16LE(0, 20);
    if (!needZip64) return eocd;

    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(0x06064b50, 0);
    zip64Eocd.writeBigUInt64LE(44n, 4); // size of remaining record
    zip64Eocd.writeUInt16LE(45, 12);
    zip64Eocd.writeUInt16LE(45, 14);
    zip64Eocd.writeUInt32LE(0, 16);
    zip64Eocd.writeUInt32LE(0, 20);
    zip64Eocd.writeBigUInt64LE(BigInt(count), 24);
    zip64Eocd.writeBigUInt64LE(BigInt(count), 32);
    zip64Eocd.writeBigUInt64LE(cdSize, 40);
    zip64Eocd.writeBigUInt64LE(cdStart, 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(cdStart + cdSize, 8); // offset of the zip64 EOCD
    locator.writeUInt32LE(1, 16);

    return Buffer.concat([zip64Eocd, locator, eocd]);
}

/** Byte generator for the whole archive. Pulls each source's body lazily. */
async function* generate(
    sources: AsyncIterable<ZipSource> | Iterable<ZipSource>
): AsyncGenerator<Uint8Array> {
    const central: CentralRecord[] = [];
    let offset = 0n;

    for await (const source of sources as AsyncIterable<ZipSource>) {
        const isDir = source.kind === "dir";
        const name = isDir && !source.name.endsWith("/") ? `${source.name}/` : source.name;
        const nameBytes = Buffer.from(name, "utf8");
        const { time, date } = dosDateTime(source.mtime);
        // Directories carry no data descriptor; files use one (bit 3) so bytes can
        // stream before the CRC/size are known. Bit 11 flags UTF-8 names.
        const flags = isDir ? 0x0800 : 0x0808;
        const localOffset = offset;
        const sizeHint = source.size >= U32_MAX;

        const header = localHeader({ nameBytes, flags, time, date, zip64: sizeHint });
        yield header;
        offset += BigInt(header.length);

        let crc = 0xffffffff;
        let written = 0n;
        if (!isDir && source.body) {
            const reader = (await source.body()).getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    crc = crc32Update(crc, value);
                    written += BigInt(value.byteLength);
                    yield value;
                    offset += BigInt(value.byteLength);
                }
            } finally {
                reader.releaseLock();
            }
        }
        const finalCrc = (crc ^ 0xffffffff) >>> 0;
        const zip64 = written >= U32_MAX || localOffset >= U32_MAX;

        if (!isDir) {
            const descriptor = dataDescriptor(finalCrc, written, written >= U32_MAX);
            yield descriptor;
            offset += BigInt(descriptor.length);
        }

        central.push({
            nameBytes,
            flags,
            time,
            date,
            crc: isDir ? 0 : finalCrc,
            size: written,
            offset: localOffset,
            zip64,
            isDir
        });
    }

    const cdStart = offset;
    for (const record of central) {
        const header = centralHeader(record);
        yield header;
        offset += BigInt(header.length);
    }
    yield endRecords(central.length, cdStart, offset - cdStart);
}

/** Build a web ReadableStream that emits the ZIP archive for the given sources. */
export function createZipStream(
    sources: AsyncIterable<ZipSource> | Iterable<ZipSource>
): ReadableStream<Uint8Array> {
    const iterator = generate(sources)[Symbol.asyncIterator]();
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
