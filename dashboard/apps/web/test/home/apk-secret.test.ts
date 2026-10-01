/**
 * Reading the signing value out of an uploaded Philips Air+ app.
 *
 * The cases are the ones Yooork/HA_Philips_Air_Plus `apk_extract.py` checks
 * for itself - a plain app, a bundle holding the app as a split, a file with
 * none, one with two, one that is not a ZIP - on synthetic archives with
 * format-only values (never the real one), plus what this reader adds: a
 * deflated split, a value cut in two by a chunk boundary, and a bundle whose
 * size would not fit in memory being read in pieces.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { crc32 } from "@polaris-app/calendar/src/lib/zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAppSecret } from "@polaris-app/places/src/lib/integrations/apk-secret";

const GOOD = `a_${"c0ffee00".repeat(4)}`;
const OTHER = `a_${"deadbeef".repeat(4)}`;

/** A ZIP with each member stored or deflated, as an app or a bundle is. */
function zip(members: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const member of members) {
        const name = Buffer.from(member.name, "utf8");
        const body = member.deflate ? deflateRawSync(member.data) : member.data;
        const crc = crc32(member.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(member.deflate ? 8 : 0, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(member.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(member.deflate ? 8 : 0, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(member.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + body.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(members.length, 8);
    end.writeUInt16LE(members.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

/** Code with a value somewhere in a lot of other bytes. */
function dex(...values: string[]): Buffer {
    const filler = Buffer.alloc(300_000, "0123456789abcdef");
    return Buffer.concat([
        filler,
        ...values.flatMap((value) => [Buffer.from(` ${value} `), filler])
    ]);
}

let dir = "";
async function file(name: string, data: Buffer): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, data);
    return path;
}

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "apk-secret-test-"));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("the value in an uploaded app", () => {
    it("is found in a plain app's code, deflated as an app stores it", async () => {
        const path = await file(
            "plain.apk",
            zip([
                { name: "AndroidManifest.xml", data: Buffer.from("manifest"), deflate: true },
                { name: "classes.dex", data: dex(), deflate: true },
                { name: "classes2.dex", data: dex(GOOD), deflate: true }
            ])
        );
        expect(await readAppSecret(path)).toBe(GOOD);
    });

    it("is found in a bundle whose app is stored, or deflated", async () => {
        const app = zip([{ name: "classes.dex", data: dex(GOOD), deflate: true }]);
        for (const deflate of [false, true]) {
            const path = await file(
                `bundle-${deflate}.apkm`,
                zip([
                    { name: "base.apk", data: app, deflate },
                    { name: "split_config.en.apk", data: Buffer.from("not an archive") },
                    { name: "info.json", data: Buffer.from("{}") }
                ])
            );
            expect(await readAppSecret(path)).toBe(GOOD);
        }
    });

    it("is found when it straddles two chunks of the stream", async () => {
        // The reader takes a megabyte at a time; put the value across the edge.
        const data = Buffer.alloc(2 * 1024 * 1024, "x");
        data.write(GOOD, 1024 * 1024 - 10, "latin1");
        const path = await file("edge.apk", zip([{ name: "classes.dex", data }]));
        expect(await readAppSecret(path)).toBe(GOOD);
    });

    it("refuses a file with none, naming what to upload instead", async () => {
        const path = await file("none.apk", zip([{ name: "classes.dex", data: dex() }]));
        await expect(readAppSecret(path)).rejects.toThrow(
            "Polaris could not find what it needs in that file. Upload the whole Philips Air+ app, not a split or language part of it."
        );
    });

    it("refuses a file with two, rather than guessing", async () => {
        const path = await file(
            "two.apk",
            zip([{ name: "classes.dex", data: dex(GOOD, OTHER), deflate: true }])
        );
        await expect(readAppSecret(path)).rejects.toThrow(/more than one candidate/);
    });

    it("refuses a file that is not an archive", async () => {
        const path = await file("not.apk", Buffer.from("definitely not a zip file"));
        await expect(readAppSecret(path)).rejects.toThrow(/not an app file/);
    });

    it("refuses a member that claims more than the file holds", async () => {
        const good = zip([{ name: "classes.dex", data: dex(GOOD) }]);
        // Point the member's data past the end of the file.
        const at = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        good.writeUInt32LE(0x7fffffff, at + 20);
        const path = await file("broken.apk", good);
        await expect(readAppSecret(path)).rejects.toThrow(/not an app file/);
    });

    it("ignores a code value only in a member that is not code", async () => {
        const path = await file(
            "elsewhere.apk",
            zip([
                { name: "res/raw/notes.txt", data: Buffer.from(GOOD) },
                { name: "classes.dex", data: dex() }
            ])
        );
        await expect(readAppSecret(path)).rejects.toThrow(/could not find/);
    });
});
