/**
 * Turning a downloaded build into a Polaris build (`format.ts`), offline, before
 * it ships. Never run on a server.
 *
 * Reads the Sponge schematic (`.schem`, versions 2 and 3), the format current
 * world editors save. The older MCEdit `.schematic` stores numeric block ids
 * from before 1.13, and turning those into today's block states needs a full
 * legacy id table this repository does not have, so such a file is refused by
 * name rather than guessed at.
 *
 * What a build carries besides blocks - chest contents, sign text, entities - is
 * left out, and so are water and lava, which would flow out of the build's box.
 */

import { gunzipSync } from "node:zlib";
import { AIR, encodeCells, polarisBuildSchema, SIDE_MAX, type PolarisBuild } from "./format";

type Tag =
    | number
    | bigint
    | string
    | Tag[]
    | Int8Array
    | Int32Array
    | BigInt64Array
    | { [name: string]: Tag };

/** A gzipped (or plain) NBT file's root compound. */
export function readNbt(bytes: Uint8Array): Record<string, Tag> {
    const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    const text = () => {
        const length = view.getUint16(at);
        at += 2;
        const value = data.subarray(at, at + length).toString("utf8");
        at += length;
        return value;
    };
    const count = () => {
        const length = view.getInt32(at);
        at += 4;
        if (length < 0 || length > data.byteLength) throw new Error("NBT length out of range");
        return length;
    };
    const payload = (type: number): Tag => {
        switch (type) {
            case 1:
                return view.getInt8(at++);
            case 2:
                at += 2;
                return view.getInt16(at - 2);
            case 3:
                at += 4;
                return view.getInt32(at - 4);
            case 4:
                at += 8;
                return view.getBigInt64(at - 8);
            case 5:
                at += 4;
                return view.getFloat32(at - 4);
            case 6:
                at += 8;
                return view.getFloat64(at - 8);
            case 7: {
                const length = count();
                const value = new Int8Array(data.subarray(at, at + length));
                at += length;
                return value;
            }
            case 8:
                return text();
            case 9: {
                const inner = view.getInt8(at++);
                const length = count();
                return Array.from({ length }, () => payload(inner));
            }
            case 10: {
                const value: Record<string, Tag> = {};
                for (let inner = view.getInt8(at++); inner !== 0; inner = view.getInt8(at++))
                    value[text()] = payload(inner);
                return value;
            }
            case 11: {
                const length = count();
                return Int32Array.from({ length }, () => {
                    at += 4;
                    return view.getInt32(at - 4);
                });
            }
            case 12: {
                const length = count();
                return BigInt64Array.from({ length }, () => {
                    at += 8;
                    return view.getBigInt64(at - 8);
                });
            }
            default:
                throw new Error(`unknown NBT tag ${type}`);
        }
    };
    if (view.getInt8(at++) !== 10) throw new Error("not an NBT compound");
    text();
    return payload(10) as Record<string, Tag>;
}

/** Sponge's block data: one unsigned varint per cell. */
function varints(bytes: Int8Array, cells: number): number[] {
    const values: number[] = [];
    let value = 0;
    let shift = 0;
    for (const byte of bytes) {
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
            values.push(value);
            value = 0;
            shift = 0;
        } else if ((shift += 7) > 28) throw new Error("block data varint too long");
    }
    if (values.length !== cells)
        throw new Error(`block data holds ${values.length} cells, not ${cells}`);
    return values;
}

const FLUIDS = new Set(["minecraft:water", "minecraft:lava", "minecraft:bubble_column"]);
const SKIPPED = new Set([
    AIR,
    "minecraft:cave_air",
    "minecraft:void_air",
    "minecraft:structure_void",
    ...FLUIDS
]);

/** A block state with its water taken out: water would flow out of the build's box. */
function dry(state: string): string {
    const open = state.indexOf("[");
    if (open === -1) return state;
    const kept = state
        .slice(open + 1, -1)
        .split(",")
        .filter((one) => one !== "waterlogged=true");
    return kept.length === 0 ? state.slice(0, open) : `${state.slice(0, open)}[${kept.join(",")}]`;
}

/** A Sponge schematic's bytes as a Polaris build. */
export function convertSponge(
    bytes: Uint8Array,
    id: string,
    season: PolarisBuild["season"]
): PolarisBuild {
    const root = readNbt(bytes);
    const schematic = (typeof root.Schematic === "object" ? root.Schematic : root) as Record<
        string,
        Tag
    >;
    // Version 2 keeps the palette at the top, version 3 under `Blocks`; the MCEdit
    // format has `Blocks` too, as a plain array of numeric ids and no palette.
    const holder = schematic.Palette !== undefined ? schematic : schematic.Blocks;
    if (
        !holder ||
        typeof holder !== "object" ||
        ArrayBuffer.isView(holder) ||
        !("Palette" in holder)
    )
        throw new Error(
            "an MCEdit .schematic (numeric ids from before 1.13): no legacy id table to convert it with"
        );
    const blocks = holder as Record<string, Tag>;
    const size = {
        x: Number(schematic.Width),
        y: Number(schematic.Height),
        z: Number(schematic.Length)
    };
    if (Object.values(size).some((side) => !(side >= 1 && side <= SIDE_MAX)))
        throw new Error(`too large to place near spawn: ${size.x}x${size.y}x${size.z}`);
    const source = blocks.Palette as Record<string, Tag>;
    const data = (blocks.Data ?? blocks.BlockData) as Int8Array;
    const names: string[] = [];
    for (const [name, index] of Object.entries(source)) names[Number(index)] = name;
    // Air first, every other kept state after it; fluids and voids become air.
    const palette = [AIR];
    const remap = names.map((name) => {
        if (SKIPPED.has(name.replace(/\[.*$/, ""))) return 0;
        const state = dry(name);
        const found = palette.indexOf(state);
        return found === -1 ? palette.push(state) - 1 : found;
    });
    const cells = varints(data, size.x * size.y * size.z).map((index) => remap[index] ?? 0);
    return polarisBuildSchema.parse({
        format: "polaris-build",
        version: 1,
        id,
        season,
        size,
        palette,
        blocks: encodeCells(cells)
    });
}
