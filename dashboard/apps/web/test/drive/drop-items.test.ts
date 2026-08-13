/**
 * What a drop actually carries.
 *
 * The bug this covers: every drop zone but the Drive listing read
 * `dataTransfer.files`, where a dropped FOLDER is a single zero-length entry. The
 * share page uploaded that entry as an empty file named after the folder, and the
 * drop point had no drop handling at all. Walking the transfer is the only way to
 * see inside a folder, so it is what every zone does now.
 */

import { describe, expect, it } from "vitest";
import { filesToItems, gatherDropItems } from "../../src/lib/drop-items";

/** A FileSystem file entry, as webkitGetAsEntry returns one. */
function fileEntry(name: string, body = "x") {
    return {
        isFile: true,
        isDirectory: false,
        name,
        file: (cb: (file: File) => void) => cb(new File([body], name))
    };
}

/**
 * A directory entry. readEntries is chunked and must be called until it answers
 * with an empty batch, which is the part a naive reader gets wrong: it returns
 * only the first chunk and the rest of the folder is silently dropped.
 */
function dirEntry(name: string, children: unknown[], chunk = 100) {
    let served = 0;
    return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => ({
            readEntries: (cb: (entries: unknown[]) => void) => {
                const batch = children.slice(served, served + chunk);
                served += batch.length;
                cb(batch);
            }
        })
    };
}

/** A DataTransfer carrying the given entries, with the flat file list beside it. */
function transfer(entries: unknown[], files: File[] = []): DataTransfer {
    return {
        items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
        files: files as unknown as FileList
    } as unknown as DataTransfer;
}

describe("what a drop carries", () => {
    it("keeps a dropped folder's files, with their paths under it", async () => {
        const items = await gatherDropItems(
            transfer([
                dirEntry("report", [
                    fileEntry("cover.pdf"),
                    dirEntry("data", [fileEntry("q1.csv"), fileEntry("q2.csv")])
                ])
            ])
        );

        expect(items.map((item) => item.relPath).sort()).toEqual([
            "report/cover.pdf",
            "report/data/q1.csv",
            "report/data/q2.csv"
        ]);
    });

    it("reads every chunk a directory returns, not just the first", async () => {
        const children = Array.from({ length: 250 }, (_, index) => fileEntry(`f${index}.txt`));
        const items = await gatherDropItems(transfer([dirEntry("bulk", children, 100)]));

        expect(items).toHaveLength(250);
    });

    it("takes several files and folders dropped together", async () => {
        const items = await gatherDropItems(
            transfer([fileEntry("loose.txt"), dirEntry("folder", [fileEntry("inside.txt")])])
        );

        expect(items.map((item) => item.relPath)).toEqual(["loose.txt", "folder/inside.txt"]);
    });

    it("falls back to the flat list when the browser exposes no entries", async () => {
        const items = await gatherDropItems(transfer([], [new File(["x"], "plain.txt")]));

        expect(items).toEqual([{ file: expect.any(File), relPath: "plain.txt" }]);
    });

    it("skips a folder entry that cannot be read rather than uploading it as a file", async () => {
        // What `dataTransfer.files` would have handed the old share page: the folder
        // itself, as one entry with no contents.
        const items = await gatherDropItems(transfer([{ name: "folder", isDirectory: true }]));

        expect(items).toEqual([]);
    });
});

describe("what a picker carries", () => {
    it("keeps the folder-relative path a directory picker reports", () => {
        const file = new File(["x"], "q1.csv");
        Object.defineProperty(file, "webkitRelativePath", { value: "report/data/q1.csv" });

        expect(filesToItems([file] as unknown as FileList)[0].relPath).toBe("report/data/q1.csv");
    });

    it("falls back to the name for a plain file picker", () => {
        expect(filesToItems([new File(["x"], "plain.txt")] as unknown as FileList)[0].relPath).toBe(
            "plain.txt"
        );
    });
});
