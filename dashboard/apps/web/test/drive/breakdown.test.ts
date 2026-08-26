/**
 * Where the room went, on a disk that fits in a test.
 *
 * The three rankings are the whole feature, and each of them has one way of
 * being quietly wrong: a folder credited with only what is directly in it, a
 * format that counts files instead of bytes, and a walk that stops early and
 * reports its total as if it had finished. The last one is the dangerous one -
 * an under-report reads as "there is nothing here worth deleting", which is the
 * opposite of the truth.
 */

import { describe, expect, it } from "vitest";
import type { StorageDriver } from "@polaris/storage";
import { driveBreakdown } from "@/lib/drive-breakdown";

/** A file tree, as paths to sizes. Folders are implied by the paths. */
function fakeDrive(files: Record<string, number>, options: { slowAt?: string } = {}): StorageDriver {
    const dirs = new Set<string>([""]);
    for (const path of Object.keys(files)) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
    }
    return {
        list: async (path: string) => {
            // One folder that takes longer than the whole budget, so the walk has
            // to give up part way through and say so.
            if (options.slowAt === path) await new Promise((resolve) => setTimeout(resolve, 60));
            const prefix = path === "" ? "" : `${path}/`;
            const depth = path === "" ? 0 : path.split("/").length;
            const entries = [
                ...[...dirs]
                    .filter((dir) => dir !== "" && dir.startsWith(prefix) && dir.split("/").length === depth + 1)
                    .map((dir) => ({
                        name: dir.slice(dir.lastIndexOf("/") + 1),
                        path: dir,
                        kind: "dir" as const,
                        size: 0n,
                        modifiedAt: new Date(0)
                    })),
                ...Object.entries(files)
                    .filter(([file]) => file.startsWith(prefix) && file.split("/").length === depth + 1)
                    .map(([file, size]) => ({
                        name: file.slice(file.lastIndexOf("/") + 1),
                        path: file,
                        kind: "file" as const,
                        size: BigInt(size),
                        modifiedAt: new Date(0)
                    }))
            ];
            return { entries };
        }
    } as unknown as StorageDriver;
}

const TREE = {
    "photos/2024/a.jpg": 300,
    "photos/2024/b.jpg": 200,
    "photos/raw/c.CR2": 900,
    "backups/db.sql.gz": 4000,
    "backups/old/db.sql.gz": 1000,
    "notes.md": 10
};

describe("driveBreakdown", () => {
    it("credits a folder with everything underneath it, not just its own files", () => {
        // The reason to walk at all: "photos" holds nothing directly, and it is
        // the second largest thing on this disk.
        return driveBreakdown(fakeDrive(TREE), "").then((report) => {
            expect(report.folders.map((folder) => [folder.name, folder.bytes])).toEqual([
                ["backups", 5000],
                ["photos", 1400]
            ]);
        });
    });

    it("counts a file at the top level in the total but under no folder", async () => {
        const report = await driveBreakdown(fakeDrive(TREE), "");
        expect(report.bytes).toBe(6410);
        expect(report.folders.some((folder) => folder.name === "notes.md")).toBe(false);
    });

    it("ranks formats by what they weigh, not by how many there are", async () => {
        // Three jpg-ish files against one archive: the archive wins, because the
        // question is about room.
        const report = await driveBreakdown(fakeDrive(TREE), "");
        expect(report.formats[0]).toMatchObject({ ext: "gz", bytes: 5000, files: 2 });
        expect(report.formats.find((format) => format.ext === "jpg")).toMatchObject({ bytes: 500, files: 2 });
    });

    it("reads an extension in whatever case it was written in", async () => {
        const report = await driveBreakdown(fakeDrive(TREE), "");
        expect(report.formats.find((format) => format.ext === "cr2")).toMatchObject({ bytes: 900 });
    });

    it("does not read a dotfile as a format", async () => {
        const report = await driveBreakdown(fakeDrive({ ".env": 20 }), "");
        expect(report.formats).toEqual([{ ext: "", label: "No extension", bytes: 20, files: 1 }]);
    });

    it("names the folder a big file is in, which is where opening it has to go", async () => {
        const report = await driveBreakdown(fakeDrive(TREE), "");
        expect(report.files[0]).toMatchObject({ name: "db.sql.gz", folder: "backups", bytes: 4000 });
    });

    it("says so when it ran out of time instead of reporting a total it did not reach", async () => {
        const report = await driveBreakdown(fakeDrive(TREE, { slowAt: "backups" }), "", { budgetMs: 20 });
        expect(report.partial).toBe(true);
    });

    it("finishes a small disk without claiming it stopped early", async () => {
        const report = await driveBreakdown(fakeDrive(TREE), "");
        expect(report.partial).toBe(false);
    });

    it("leaves a locked folder out of the walk and out of the totals", async () => {
        const report = await driveBreakdown(fakeDrive(TREE), "", { skip: new Set(["backups"]) });
        expect(report.bytes).toBe(1410);
        expect(report.folders.map((folder) => folder.name)).toEqual(["photos"]);
    });
});
