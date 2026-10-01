/**
 * The signing value the Philips Air+ app (com.philips.ph.homecare) carries in its own code, read out of a
 * copy of the app that the person connecting uploaded.
 *
 * Philips' fan and heater cloud (`air-matters.ts`) only signs somebody in when
 * the request is signed with this value, and Philips hands it out nowhere: it
 * is a constant inside the app. So, exactly as Yooork/HA_Philips_Air_Plus does
 * in `apk_extract.py`, the person provides their own copy of the app and the
 * value is read out of it. Polaris never ships it, never publishes it, and
 * never keeps the file - the caller deletes the upload as soon as this returns.
 *
 * How: an app file is a ZIP; its code is in `classes*.dex` members; the value is
 * written there as plain text, `a_` followed by 32 hex digits, and that prefix
 * makes it unambiguous (one hit in a real app, where a bare 32-hex pattern finds
 * dozens). A bundle (`.apkm`, `.xapk`) is a ZIP of app files, so one level of
 * `*.apk` members is opened in turn. Nothing in the file is ever run.
 *
 * Written against the ZIP format itself (PKWARE APPNOTE 6.3: end of central
 * directory, its ZIP64 form, central and local headers) with `node:zlib` for
 * the deflated members, rather than a library that reads the whole file into
 * memory: an app bundle is well over a hundred megabytes. Every size is
 * bounded, so a crafted file cannot make it inflate without end.
 *
 * Server-only.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeError } from "../home-error";
import { createReadStream, createWriteStream } from "node:fs";
import { createInflateRaw } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { mkdtemp, open, rm } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";

const SECRET = /a_[0-9a-f]{32}/g;
/** How much of the end of a match can sit in one chunk and the rest in the next. */
const OVERLAP = 33;

/** No more than this is inflated in all, across every member read. A real app
 *  inflates to a few hundred megabytes of code at most. */
const INFLATE_LIMIT = 2 * 1024 * 1024 * 1024;
/** Members looked at, per archive. */
const ENTRY_LIMIT = 200_000;
/** The end-of-directory record is in the last 64 KiB plus its own size. */
const TAIL = 65_535 + 22;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

function notAnApp(): HomeError {
    return new HomeError(
        "That file is not an app file. Upload the Philips Air+ app as an .apk, .apkm or .xapk file."
    );
}

/** One member of an archive, where its data is and how it is stored. */
interface Member {
    readonly name: string;
    readonly method: number;
    readonly compressed: number;
    readonly size: number;
    readonly localOffset: number;
}

type Handle = Awaited<ReturnType<typeof open>>;

async function readAt(file: Handle, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    if (bytesRead !== length) throw notAnApp();
    return buffer;
}

/** A 64-bit little-endian size as a number, refusing one past what a file can be. */
function uint64(buffer: Buffer, at: number): number {
    const value = buffer.readBigUInt64LE(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw notAnApp();
    return Number(value);
}

/** Where the central directory of the archive at `[start, start + length)` is. */
async function directory(
    file: Handle,
    start: number,
    length: number
): Promise<{ offset: number; size: number; count: number }> {
    if (length < 22) throw notAnApp();
    const tailLength = Math.min(length, TAIL);
    const tailStart = start + length - tailLength;
    const tail = await readAt(file, tailStart, tailLength);
    let at = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
        if (tail.readUInt32LE(index) === EOCD) {
            at = index;
            break;
        }
    }
    if (at < 0) throw notAnApp();
    let count = tail.readUInt16LE(at + 10);
    let size = tail.readUInt32LE(at + 12);
    let offset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
        // ZIP64: the locator sits right before the classic record.
        const locatorAt = tailStart + at - 20;
        if (locatorAt < start) throw notAnApp();
        const locator = await readAt(file, locatorAt, 20);
        if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw notAnApp();
        const recordAt = start + uint64(locator, 8);
        const record = await readAt(file, recordAt, 56);
        if (record.readUInt32LE(0) !== ZIP64_EOCD) throw notAnApp();
        count = uint64(record, 32);
        size = uint64(record, 40);
        offset = uint64(record, 48);
    }
    if (offset + size > length || count > ENTRY_LIMIT) throw notAnApp();
    return { offset: start + offset, size, count };
}

/** Every member the central directory names. */
async function members(file: Handle, start: number, length: number): Promise<Member[]> {
    const where = await directory(file, start, length);
    const table = await readAt(file, where.offset, where.size);
    const found: Member[] = [];
    let at = 0;
    for (let index = 0; index < where.count; index++) {
        if (at + 46 > table.length || table.readUInt32LE(at) !== CENTRAL) throw notAnApp();
        const method = table.readUInt16LE(at + 10);
        let compressed = table.readUInt32LE(at + 20);
        let size = table.readUInt32LE(at + 24);
        const nameLength = table.readUInt16LE(at + 28);
        const extraLength = table.readUInt16LE(at + 30);
        const commentLength = table.readUInt16LE(at + 32);
        let localOffset = table.readUInt32LE(at + 42);
        const nameEnd = at + 46 + nameLength;
        if (nameEnd + extraLength > table.length) throw notAnApp();
        const name = table.toString("utf8", at + 46, nameEnd);
        // A ZIP64 extra field holds whichever of the three did not fit, in order.
        let extra = nameEnd;
        while (extra + 4 <= nameEnd + extraLength) {
            const id = table.readUInt16LE(extra);
            const fieldLength = table.readUInt16LE(extra + 2);
            if (id === 0x0001) {
                let field = extra + 4;
                if (size === 0xffffffff) {
                    size = uint64(table, field);
                    field += 8;
                }
                if (compressed === 0xffffffff) {
                    compressed = uint64(table, field);
                    field += 8;
                }
                if (localOffset === 0xffffffff) localOffset = uint64(table, field);
                break;
            }
            extra += 4 + fieldLength;
        }
        found.push({ name, method, compressed, size, localOffset: start + localOffset });
        at = nameEnd + extraLength + commentLength;
    }
    return found;
}

/** Where a member's own bytes begin, past its local header. */
async function dataStart(file: Handle, member: Member, end: number): Promise<number> {
    const header = await readAt(file, member.localOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw notAnApp();
    const at = member.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (at + member.compressed > end) throw notAnApp();
    return at;
}

/** A shared allowance of inflated bytes, so a crafted file stops rather than
 *  filling the disk or the memory. */
class Budget {
    private left = INFLATE_LIMIT;
    spend(bytes: number): void {
        this.left -= bytes;
        if (this.left < 0) throw notAnApp();
    }
}

/** A member's content as a stream: as stored, or inflated within the budget. */
function contentOf(path: string, member: Member, at: number, budget: Budget): Readable {
    const raw = createReadStream(path, {
        start: at,
        end: at + member.compressed - 1,
        highWaterMark: 1024 * 1024
    });
    if (member.method === STORED) return raw;
    if (member.method !== DEFLATED) throw notAnApp();
    const inflate = createInflateRaw();
    const metered = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            try {
                budget.spend(chunk.length);
                done(null, chunk);
            } catch (caught) {
                done(caught as Error);
            }
        }
    });
    raw.on("error", (error) => inflate.destroy(error));
    raw.pipe(inflate).on("error", (error) => metered.destroy(error));
    return inflate.pipe(metered);
}

/** Every candidate in a stream, a match split across two chunks included. */
async function scan(stream: Readable, hits: Set<string>): Promise<void> {
    let carry = "";
    try {
        for await (const chunk of stream) {
            const text = carry + (chunk as Buffer).toString("latin1");
            for (const match of text.matchAll(SECRET)) hits.add(match[0]);
            carry = text.slice(-OVERLAP);
        }
    } catch (caught) {
        if (caught instanceof HomeError) throw caught;
        throw notAnApp();
    }
}

/** Read one archive's code members, and - at the top level only - the app
 *  files a bundle carries. */
async function searchArchive(
    path: string,
    file: Handle,
    start: number,
    length: number,
    depth: number,
    budget: Budget,
    hits: Set<string>
): Promise<void> {
    const end = start + length;
    for (const member of await members(file, start, length)) {
        const lower = member.name.toLowerCase();
        if (lower.endsWith(".dex")) {
            const at = await dataStart(file, member, end);
            await scan(contentOf(path, member, at, budget), hits);
        } else if (lower.endsWith(".apk") && depth === 0) {
            const at = await dataStart(file, member, end);
            if (member.method === STORED) {
                await searchInner(path, file, at, member.compressed, budget, hits);
                continue;
            }
            // A deflated app inside a bundle is inflated to a scratch file of
            // its own, read, and removed.
            const scratch = await mkdtemp(join(tmpdir(), "polaris-apk-"));
            try {
                const inner = join(scratch, "inner.apk");
                await pipeline(contentOf(path, member, at, budget), createWriteStream(inner));
                const innerFile = await open(inner, "r");
                try {
                    const { size } = await innerFile.stat();
                    await searchInner(inner, innerFile, 0, size, budget, hits);
                } finally {
                    await innerFile.close();
                }
            } catch (caught) {
                if (caught instanceof HomeError) throw caught;
                throw notAnApp();
            } finally {
                await rm(scratch, { recursive: true, force: true });
            }
        }
    }
}

/** An app inside a bundle. One that turns out not to be an archive - a split
 *  that is something else - is passed over rather than failing the bundle. */
async function searchInner(
    path: string,
    file: Handle,
    start: number,
    length: number,
    budget: Budget,
    hits: Set<string>
): Promise<void> {
    try {
        await searchArchive(path, file, start, length, 1, budget, hits);
    } catch (caught) {
        if (!(caught instanceof HomeError) || caught.message !== notAnApp().message) throw caught;
    }
}

/**
 * The one signing value in an uploaded app or bundle. Refuses a file that is
 * not an archive, one with no candidate, and one with more than one - a wrong
 * guess would only fail later, at Philips, with less to go on.
 */
export async function readAppSecret(path: string): Promise<string> {
    const file = await open(path, "r").catch(() => {
        throw notAnApp();
    });
    const hits = new Set<string>();
    try {
        const { size } = await file.stat();
        await searchArchive(path, file, 0, size, 0, new Budget(), hits);
    } finally {
        await file.close();
    }
    if (hits.size === 0) {
        throw new HomeError(
            "Polaris could not find what it needs in that file. Upload the whole Philips Air+ app, not a split or language part of it."
        );
    }
    if (hits.size > 1) {
        throw new HomeError(
            "That file holds more than one candidate, so Polaris cannot tell which one Philips uses. Upload the Philips Air+ app itself."
        );
    }
    return [...hits][0]!;
}
