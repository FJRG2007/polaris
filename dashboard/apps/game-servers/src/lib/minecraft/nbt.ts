/**
 * Reading Java's NBT files (`scoreboard.dat`, `level.dat`) into plain values.
 *
 * The format is big-endian, usually gzipped, and has thirteen tag types. Every
 * one is decoded rather than skipped, because a compound is only walkable when
 * every tag before the one wanted has been read through. Bytes become numbers,
 * longs become bigints, compounds become objects and lists arrays. Bounded: a
 * file nesting deeper than any the game writes, or claiming more entries than it
 * has bytes, is refused rather than followed.
 */

import { gunzipSync, inflateSync } from "node:zlib";

const MAX_DEPTH = 64;

export type NbtValue =
    | number
    | bigint
    | string
    | NbtValue[]
    | { [key: string]: NbtValue }
    | Int8Array
    | Int32Array
    | BigInt64Array;

class Reader {
    private at = 0;
    constructor(private readonly bytes: Buffer) {}

    private need(count: number): void {
        if (count < 0 || this.at + count > this.bytes.length) throw new Error("NBT ends early");
    }
    byte(): number {
        this.need(1);
        return this.bytes.readInt8(this.at++);
    }
    short(): number {
        this.need(2);
        const value = this.bytes.readInt16BE(this.at);
        this.at += 2;
        return value;
    }
    int(): number {
        this.need(4);
        const value = this.bytes.readInt32BE(this.at);
        this.at += 4;
        return value;
    }
    long(): bigint {
        this.need(8);
        const value = this.bytes.readBigInt64BE(this.at);
        this.at += 8;
        return value;
    }
    float(): number {
        this.need(4);
        const value = this.bytes.readFloatBE(this.at);
        this.at += 4;
        return value;
    }
    double(): number {
        this.need(8);
        const value = this.bytes.readDoubleBE(this.at);
        this.at += 8;
        return value;
    }
    string(): string {
        const length = this.bytes.readUInt16BE((this.need(2), this.at));
        this.at += 2;
        this.need(length);
        // Java's modified UTF-8 differs from UTF-8 only for NUL and characters
        // outside the BMP, neither of which a team or a name holds.
        const value = this.bytes.toString("utf8", this.at, this.at + length);
        this.at += length;
        return value;
    }
    count(width: number): number {
        const length = this.int();
        this.need(length * width);
        return length;
    }

    payload(type: number, depth: number): NbtValue {
        if (depth > MAX_DEPTH) throw new Error("NBT nests too deep");
        switch (type) {
            case 1:
                return this.byte();
            case 2:
                return this.short();
            case 3:
                return this.int();
            case 4:
                return this.long();
            case 5:
                return this.float();
            case 6:
                return this.double();
            case 7: {
                const length = this.count(1);
                const out = new Int8Array(length);
                for (let index = 0; index < length; index += 1) out[index] = this.byte();
                return out;
            }
            case 8:
                return this.string();
            case 9: {
                const inner = this.byte();
                const length = this.int();
                if (length < 0 || (inner === 0 && length > 0) || length > this.bytes.length)
                    throw new Error("NBT list is malformed");
                const out: NbtValue[] = [];
                for (let index = 0; index < length; index += 1)
                    out.push(this.payload(inner, depth + 1));
                return out;
            }
            case 10: {
                const out: { [key: string]: NbtValue } = {};
                for (;;) {
                    const inner = this.byte();
                    if (inner === 0) return out;
                    const key = this.string();
                    out[key] = this.payload(inner, depth + 1);
                }
            }
            case 11: {
                const length = this.count(4);
                const out = new Int32Array(length);
                for (let index = 0; index < length; index += 1) out[index] = this.int();
                return out;
            }
            case 12: {
                const length = this.count(8);
                const out = new BigInt64Array(length);
                for (let index = 0; index < length; index += 1) out[index] = this.long();
                return out;
            }
            default:
                throw new Error(`NBT tag ${type} is not known`);
        }
    }
}

/** The root compound of an NBT file, gzipped, zlib-compressed or raw. */
export function readNbt(file: Buffer): { [key: string]: NbtValue } {
    let bytes = file;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
        bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
    else if (bytes[0] === 0x78) bytes = inflateSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
    const reader = new Reader(bytes);
    const type = reader.byte();
    if (type !== 10) throw new Error("NBT root is not a compound");
    reader.string();
    return reader.payload(10, 0) as { [key: string]: NbtValue };
}
