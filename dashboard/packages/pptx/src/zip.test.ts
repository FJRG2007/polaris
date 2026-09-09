/**
 * What a package is allowed to cost to unpack.
 *
 * The engine opens whatever bytes it is handed, and one of the things handing
 * them over is an HTTP route: a file small enough to accept as a request body
 * still describes as many parts, and as many bytes inside them, as its author
 * wanted it to. Unpacking those is what allocates them, and the process that
 * runs out of memory doing it is the one serving everybody.
 *
 * The two limits are asserted here against packages built to cross them, and a
 * real presentation is opened alongside so a limit tightened too far fails as
 * loudly as one missing.
 */

import JSZip from "jszip";
import { PackageArchive } from "./zip";
import { createBlankPptx } from "./blank";
import { describe, expect, it } from "vitest";

/** Rewrite the unpacked size every central-directory record declares.
 *
 *  JSZip takes an entry's sizes from the central directory rather than from the
 *  local header, so this is the number the guard reads - and a package that
 *  claims a size it does not have is exactly the shape being refused. */
function claimUnpackedSize(zip: Uint8Array, size: number): Uint8Array {
    const copy = Buffer.from(zip);
    for (let at = 0; at + 46 <= copy.length; at++) {
        if (copy.readUInt32LE(at) !== 0x02014b50) continue;
        copy.writeUInt32LE(size, at + 24);
    }
    return new Uint8Array(copy);
}

describe("opening a package", () => {
    it("opens a real presentation", async () => {
        const archive = await PackageArchive.open(await createBlankPptx());
        expect(archive.has("ppt/presentation.xml")).toBe(true);
    });

    it("refuses one that holds more parts than any presentation does", async () => {
        const zip = new JSZip();
        for (let at = 0; at <= 8192; at++) zip.file(`media/${at}.bin`, "x");
        const bytes = await zip.generateAsync({ type: "uint8array" });
        await expect(PackageArchive.open(bytes)).rejects.toThrow(/more than 8192 parts/);
    });

    it("refuses one that declares more than it may unpack to, before unpacking any of it", async () => {
        // A hundred kilobytes of nothing deflates to almost nothing, which is
        // the whole trick: the file is small and what it describes is not.
        const zip = new JSZip();
        zip.file("media/bomb.bin", new Uint8Array(100 * 1024));
        const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        const claiming = claimUnpackedSize(bytes, 400 * 1024 * 1024);
        expect(claiming.byteLength).toBeLessThan(64 * 1024);
        await expect(PackageArchive.open(claiming)).rejects.toThrow(/declares more than/);
    });
});
