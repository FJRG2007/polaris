/**
 * An executable's `FileDescription`, read from its version resource without
 * running it - what tells an installed program in `App Paths` from a nameless
 * helper. The executables are built here, byte by byte: a minimal PE32+ with
 * one `.rsrc` section, and broken ones that must yield nothing.
 */

import { describe, expect, it } from "vitest";
import { exeDescriptionFrom, versionDescription, type ReadAt } from "../../src/main/launcher-exe-info";

/** A `VS_VERSIONINFO`-shaped block holding one `FileDescription` string. */
function versionBlock(description: string): Buffer {
    const key = Buffer.from("FileDescription\0", "utf16le");
    const value = Buffer.from(`${description}\0`, "utf16le");
    const header = Buffer.alloc(6);
    header.writeUInt16LE(6 + key.length + 2 + value.length, 0);
    header.writeUInt16LE(value.length / 2, 2);
    header.writeUInt16LE(1, 4);
    return Buffer.concat([Buffer.alloc(8), header, key, Buffer.alloc(2), value]);
}

/** A minimal PE32+ whose resource section holds `block` as its version resource. */
function executable(block: Buffer): Buffer {
    const file = Buffer.alloc(0x200 + 0x58 + block.length);
    file.write("MZ", 0, "latin1");
    file.writeUInt32LE(0x40, 0x3c);
    file.write("PE\0\0", 0x40, "latin1");
    file.writeUInt16LE(0x8664, 0x44);
    file.writeUInt16LE(1, 0x46);
    file.writeUInt16LE(0xf0, 0x54);
    file.writeUInt16LE(0x20b, 0x58);
    file.writeUInt32LE(0x1000, 0x58 + 112 + 16);
    file.writeUInt32LE(0x58 + block.length, 0x58 + 112 + 20);
    const section = 0x58 + 0xf0;
    file.write(".rsrc", section, "latin1");
    file.writeUInt32LE(0x58 + block.length, section + 8);
    file.writeUInt32LE(0x1000, section + 12);
    file.writeUInt32LE(0x58 + block.length, section + 16);
    file.writeUInt32LE(0x200, section + 20);
    const rsrc = 0x200;
    // Type 16 (version) -> name 1 -> language 0x409 -> data entry.
    file.writeUInt16LE(1, rsrc + 14);
    file.writeUInt32LE(16, rsrc + 16);
    file.writeUInt32LE((0x80000000 | 0x18) >>> 0, rsrc + 20);
    file.writeUInt16LE(1, rsrc + 0x18 + 14);
    file.writeUInt32LE(1, rsrc + 0x28);
    file.writeUInt32LE((0x80000000 | 0x30) >>> 0, rsrc + 0x2c);
    file.writeUInt16LE(1, rsrc + 0x30 + 14);
    file.writeUInt32LE(0x409, rsrc + 0x40);
    file.writeUInt32LE(0x48, rsrc + 0x44);
    file.writeUInt32LE(0x1000 + 0x58, rsrc + 0x48);
    file.writeUInt32LE(block.length, rsrc + 0x4c);
    block.copy(file, rsrc + 0x58);
    return file;
}

const reader = (file: Buffer): ReadAt => async (offset, length) => file.subarray(offset, offset + length);

describe("an executable's description", () => {
    it("is read from its version resource", async () => {
        expect(await exeDescriptionFrom(reader(executable(versionBlock("Fixture Pad"))))).toBe("Fixture Pad");
    });

    it("is read from the version block alone, accents and all", () => {
        expect(versionDescription(versionBlock("Éditeur de fixture"))).toBe("Éditeur de fixture");
        expect(versionDescription(versionBlock(""))).toBeNull();
        expect(versionDescription(Buffer.from("no strings here"))).toBeNull();
    });

    it("is nothing for a file that is not an executable, or is cut short", async () => {
        const whole = executable(versionBlock("Fixture Pad"));
        expect(await exeDescriptionFrom(reader(Buffer.from("not an executable at all, just text")))).toBeNull();
        expect(await exeDescriptionFrom(reader(whole.subarray(0, 0x150)))).toBeNull();
        expect(await exeDescriptionFrom(reader(whole.subarray(0, 0x230)))).toBeNull();
    });

    it("is nothing when the resource section has no version resource", async () => {
        const file = executable(versionBlock("Fixture Pad"));
        file.writeUInt32LE(3, 0x200 + 16);
        expect(await exeDescriptionFrom(reader(file))).toBeNull();
    });
});
