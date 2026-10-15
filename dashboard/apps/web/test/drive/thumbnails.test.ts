/**
 * What decides whether a file is ever opened for a picture.
 *
 * The grid's whole cost is in these two answers, so they are asserted rather
 * than trusted. A folder of four hundred entries scrolls past without reading
 * one of them because `thumbnailKind` says no for most names before anything is
 * requested, and because the ceiling refuses the ones that would be read into
 * memory to produce four kilobytes.
 *
 * The key is here for the property the caching rests on: it changes when the
 * file changes. That is what lets the answer be held in a browser for a year
 * and still never be wrong - an edited file asks for a name that does not exist
 * yet rather than being served a stale picture.
 */

import { describe, expect, it } from "vitest";
import { thumbnailKey, thumbnailPath } from "@/lib/drive-thumbnail";
import { thumbnailKind, withinCeiling } from "@/lib/drive-thumbnail-kind";

const MB = 1024 * 1024;

describe("what a file manager can draw", () => {
    it("draws the things somebody would recognise by sight", () => {
        for (const name of ["holiday.JPG", "scan.png", "logo.svg", "frame.heic", "shot.webp"]) {
            expect(thumbnailKind(name), name).toBe("image");
        }
        expect(thumbnailKind("contract.pdf")).toBe("pdf");
    });

    it("says no before anything is opened, for everything else", () => {
        // The point of answering by name: this decision is what stops the file
        // being read at all, so it cannot be one that reads the file.
        for (const name of ["notes.txt", "sheet.xlsx", "backup.zip", "video.mp4", "Makefile"]) {
            expect(thumbnailKind(name), name).toBeNull();
        }
        // A name with no extension, and a folder-ish name with a dot in it.
        expect(thumbnailKind("README")).toBeNull();
        expect(thumbnailKind("my.photos")).toBeNull();
    });

    it("refuses a file too big to be worth reading into memory", () => {
        expect(withinCeiling("image", BigInt(2 * MB))).toBe(true);
        expect(withinCeiling("image", BigInt(41 * MB))).toBe(false);
        // A scanned book is a legitimate PDF and gets more room than an image.
        expect(withinCeiling("pdf", BigInt(50 * MB))).toBe(true);
        expect(withinCeiling("pdf", BigInt(61 * MB))).toBe(false);
    });

    it("refuses an empty file, which has nothing to draw", () => {
        expect(withinCeiling("image", 0n)).toBe(false);
    });
});

describe("the name a picture is kept under", () => {
    const when = new Date("2026-01-02T03:04:05.000Z");

    it("is the same for the same file, so the second visit reads nothing", () => {
        expect(thumbnailKey("c1", "a/b.png", when, 10n)).toBe(
            thumbnailKey("c1", "a/b.png", when, 10n)
        );
    });

    it("changes when the file does, so no stale picture can be served", () => {
        const original = thumbnailKey("c1", "a/b.png", when, 10n);
        // Edited: a different moment, or a different size, is a different name -
        // which is why nothing has to be invalidated when a file changes.
        expect(thumbnailKey("c1", "a/b.png", new Date(when.getTime() + 1000), 10n)).not.toBe(
            original
        );
        expect(thumbnailKey("c1", "a/b.png", when, 11n)).not.toBe(original);
    });

    it("keeps two drives apart, and two files apart", () => {
        const original = thumbnailKey("c1", "a/b.png", when, 10n);
        expect(thumbnailKey("c2", "a/b.png", when, 10n)).not.toBe(original);
        expect(thumbnailKey("c1", "a/c.png", when, 10n)).not.toBe(original);
    });

    it("lands under Polaris's own directory, in a shard", () => {
        // Sharded because a directory holding a hundred thousand entries is slow
        // to open on every filesystem there is; under a name of ours because a
        // drive that grows a hidden thumbnails folder is one somebody will find
        // on their NAS and wonder about.
        const key = thumbnailKey("c1", "a/b.png", when, 10n);
        expect(thumbnailPath(key)).toBe(`polaris/thumbnails/${key.slice(0, 2)}/${key}.webp`);
    });
});
