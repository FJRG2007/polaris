/**
 * Which files get a picture on their tile, and who draws it.
 *
 * Two answers, and the split is about cost. An image or a document is drawn on
 * the server, where the original is read once and cached forever. A video is
 * drawn by the browser from the file itself: the server would need a decoder to
 * open one and would have to read the whole thing into memory to produce four
 * kilobytes, while the browser already holds a decoder and the download route
 * honours Range - so a four-gigabyte film costs the first chunk of itself.
 */

import { describe, expect, it } from "vitest";
import { drawsItsOwnFrame, thumbnailKind, withinCeiling } from "@/lib/drive-thumbnail-kind";

describe("what the server draws", () => {
    it("draws the pictures and the documents", () => {
        expect(thumbnailKind("holiday.JPG")).toBe("image");
        expect(thumbnailKind("scan.heic")).toBe("image");
        expect(thumbnailKind("contract.pdf")).toBe("pdf");
    });

    it("leaves everything else to its icon", () => {
        expect(thumbnailKind("notes.txt")).toBeNull();
        expect(thumbnailKind("archive.zip")).toBeNull();
        expect(thumbnailKind("no-extension")).toBeNull();
    });

    // A request that reads a gigabyte to produce four kilobytes is one that
    // should not have been made.
    it("will not open something enormous", () => {
        expect(withinCeiling("image", 5n * 1024n * 1024n)).toBe(true);
        expect(withinCeiling("image", 500n * 1024n * 1024n)).toBe(false);
        expect(withinCeiling("pdf", 0n)).toBe(false);
    });
});

describe("what the browser draws", () => {
    it("takes the videos it can play", () => {
        expect(drawsItsOwnFrame("clip.mp4")).toBe(true);
        expect(drawsItsOwnFrame("Recording.MOV")).toBe(true);
        expect(drawsItsOwnFrame("talk.webm")).toBe(true);
    });

    // The two paths must not both claim the same file: the server has no decoder
    // for a video, and a tile that asked it for one would get a refusal and keep
    // its icon while the browser could have drawn it.
    it("never claims a file the server draws", () => {
        for (const name of ["holiday.jpg", "contract.pdf", "chart.png"]) {
            expect(drawsItsOwnFrame(name)).toBe(false);
        }
    });

    it("leaves a format browsers do not play alone", () => {
        expect(drawsItsOwnFrame("film.mkv")).toBe(false);
        expect(drawsItsOwnFrame("old.avi")).toBe(false);
        expect(drawsItsOwnFrame("mp4")).toBe(false);
    });
});
