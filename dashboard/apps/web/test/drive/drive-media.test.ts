// @vitest-environment jsdom

/**
 * The photo layout's decisions, without a browser: when a folder counts as a
 * folder of photos, where the day headings fall, where an arrow key lands, the
 * viewer's previous and next, and the per-folder layout memory.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useMemoryStorage } from "./fixtures/memory-storage";
import {
    dayOf,
    fileSteps,
    isMediaFolder,
    mediaKindOf,
    photoNeighbour,
    photoRows,
    steppedFile
} from "@/lib/drive-media";
import {
    REMEMBERED_FOLDERS,
    rememberViewMode,
    rememberedViewMode
} from "@/app/(app)/drive/view-mode";

function file(name: string, modifiedAt = "2026-10-01T12:00:00.000Z") {
    return { name, path: name, kind: "file" as const, modifiedAt };
}

function dir(name: string) {
    return { name, path: name, kind: "dir" as const, modifiedAt: "2026-10-01T12:00:00.000Z" };
}

describe("mediaKindOf", () => {
    it("tells pictures from videos and leaves everything else out", () => {
        expect(mediaKindOf("IMG_0001.JPG")).toBe("image");
        expect(mediaKindOf("clip.mp4")).toBe("video");
        expect(mediaKindOf("scan.pdf")).toBeNull();
        expect(mediaKindOf("notes.txt")).toBeNull();
    });
});

describe("isMediaFolder", () => {
    it("is a folder of photos at six files with seven in ten of them pictures or videos", () => {
        const album = [
            ...["a.jpg", "b.jpg", "c.png", "d.heic", "e.mp4"].map((name) => file(name)),
            file("readme.txt"),
            dir("Edits")
        ];
        expect(isMediaFolder(album)).toBe(true);
    });

    it("is not one with too few files, however many are pictures", () => {
        expect(isMediaFolder(["a.jpg", "b.jpg", "c.jpg"].map((name) => file(name)))).toBe(false);
    });

    it("is not one when documents are more than three in ten", () => {
        const mixed = [
            ...["a.jpg", "b.jpg", "c.jpg", "d.jpg"].map((name) => file(name)),
            ...["x.docx", "y.pdf"].map((name) => file(name))
        ];
        expect(isMediaFolder(mixed)).toBe(false);
    });

    it("does not count folders, so a folder of folders is never one", () => {
        expect(isMediaFolder(Array.from({ length: 10 }, (_, i) => dir(`d${i}`)))).toBe(false);
    });
});

describe("photoRows", () => {
    it("puts a heading over each day when sorted by date, keeping the listing's order", () => {
        const entries = [
            dir("Edits"),
            file("a.jpg", "2026-10-03T10:00:00"),
            file("b.jpg", "2026-10-03T09:00:00"),
            file("c.jpg", "2026-10-03T08:00:00"),
            file("d.jpg", "2026-10-03T07:00:00"),
            file("e.jpg", "2026-10-01T10:00:00")
        ];
        const rows = photoRows(entries, 3, "modifiedAt");
        expect(rows).toEqual([
            { kind: "tiles", indices: [0] },
            { kind: "heading", day: "2026-10-03", count: 4 },
            { kind: "tiles", indices: [1, 2, 3] },
            { kind: "tiles", indices: [4] },
            { kind: "heading", day: "2026-10-01", count: 1 },
            { kind: "tiles", indices: [5] }
        ]);
    });

    it("draws no headings when the listing is not sorted by date", () => {
        const entries = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"].map((name) => file(name));
        expect(photoRows(entries, 3, null)).toEqual([
            { kind: "tiles", indices: [0, 1, 2] },
            { kind: "tiles", indices: [3] }
        ]);
    });

    it("reads an unreadable date as no day rather than throwing", () => {
        expect(dayOf("not a date")).toBe("");
    });
});

describe("photoNeighbour", () => {
    const entries = [
        file("a.jpg", "2026-10-03T10:00:00"),
        file("b.jpg", "2026-10-03T09:00:00"),
        file("c.jpg", "2026-10-03T08:00:00"),
        file("d.jpg", "2026-10-03T07:00:00"),
        file("e.jpg", "2026-10-01T10:00:00"),
        file("f.jpg", "2026-10-01T09:00:00")
    ];
    // [heading] [0 1 2] [3] [heading] [4 5]
    const rows = photoRows(entries, 3, "modifiedAt");

    it("moves along the listing's order with left and right, stopping at the ends", () => {
        expect(photoNeighbour(rows, 2, "right", 6)).toBe(3);
        expect(photoNeighbour(rows, 3, "left", 6)).toBe(2);
        expect(photoNeighbour(rows, 0, "left", 6)).toBeNull();
        expect(photoNeighbour(rows, 5, "right", 6)).toBeNull();
    });

    it("moves to the tile below, clamped to a shorter row, across a heading", () => {
        expect(photoNeighbour(rows, 2, "down", 6)).toBe(3);
        expect(photoNeighbour(rows, 3, "down", 6)).toBe(4);
        expect(photoNeighbour(rows, 5, "up", 6)).toBe(3);
        expect(photoNeighbour(rows, 1, "up", 6)).toBeNull();
    });

    it("starts at the first tile, or the last going backwards, with no cursor", () => {
        expect(photoNeighbour(rows, -1, "right", 6)).toBe(0);
        expect(photoNeighbour(rows, -1, "up", 6)).toBe(5);
        expect(photoNeighbour([], -1, "down", 0)).toBeNull();
    });
});

describe("the viewer's previous and next", () => {
    const listing = [dir("Edits"), file("a.jpg"), dir("Raw"), file("b.mp4"), file("c.jpg")];

    it("steps through files in the listing's order and skips folders", () => {
        expect(steppedFile(listing, "a.jpg", 1)?.path).toBe("b.mp4");
        expect(steppedFile(listing, "b.mp4", -1)?.path).toBe("a.jpg");
        expect(steppedFile(listing, "a.jpg", -1)).toBeNull();
        expect(steppedFile(listing, "c.jpg", 1)).toBeNull();
        expect(steppedFile(listing, "gone.jpg", 1)).toBeNull();
    });

    it("counts the open file's place among files only", () => {
        expect(fileSteps(listing, "b.mp4")).toEqual({ index: 1, count: 3 });
        expect(fileSteps(listing, "gone.jpg")).toEqual({ index: -1, count: 3 });
    });
});

describe("the layout remembered per folder", () => {
    beforeEach(() => useMemoryStorage());

    it("answers what was chosen for that folder and nothing for another", () => {
        rememberViewMode("c1", "Photos/2026", "photos");
        rememberViewMode("c1", "Docs", "list");
        expect(rememberedViewMode("c1", "Photos/2026")).toBe("photos");
        expect(rememberedViewMode("c1", "Docs")).toBe("list");
        expect(rememberedViewMode("c2", "Photos/2026")).toBeNull();
    });

    it("keeps only the most recent folders", () => {
        for (let i = 0; i <= REMEMBERED_FOLDERS; i++) rememberViewMode("c1", `f${i}`, "grid");
        expect(rememberedViewMode("c1", "f0")).toBeNull();
        expect(rememberedViewMode("c1", `f${REMEMBERED_FOLDERS}`)).toBe("grid");
    });

    it("ignores a stored value it cannot read", () => {
        window.localStorage.setItem("polaris.drive.viewModes", "{not json");
        expect(rememberedViewMode("c1", "x")).toBeNull();
        window.localStorage.setItem("polaris.drive.viewModes", JSON.stringify([["c1:x", "huge"]]));
        expect(rememberedViewMode("c1", "x")).toBeNull();
    });
});
