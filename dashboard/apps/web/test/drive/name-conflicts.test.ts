/**
 * The writes behind Drive's "this name is already taken" question.
 *
 * What has to hold: a clash is found the way Drive compares names (ignoring
 * case), a name is never written over unless the person chose Replace, Keep
 * both lands on the next free "name (n).ext", and deciding a name and taking it
 * are one step - two writers told the same name was free cannot both write it.
 */

import { describe, expect, it, vi } from "vitest";
import { memoryDriver } from "./fixtures/memory-driver";
import {
    claimFileName,
    claimFolderName,
    findClashes,
    moveToName,
    NameConflictError,
    replaceWith
} from "../../src/lib/drive/name-conflicts";

describe("finding clashes", () => {
    it("matches a name in another case, and reports the spelling already there", async () => {
        const { driver } = memoryDriver({ files: { "docs/Report.pdf": "old" }, dirs: ["docs"] });
        const clashes = await findClashes(driver, ["docs/report.pdf", "docs/free.txt"]);
        expect(clashes).toEqual([
            {
                path: "docs/report.pdf",
                existingPath: "docs/Report.pdf",
                existingName: "Report.pdf",
                existingKind: "file"
            }
        ]);
    });

    it("sees a folder of the same name, and nothing in a folder that does not exist yet", async () => {
        const { driver } = memoryDriver({ dirs: ["album"] });
        const clashes = await findClashes(driver, ["album", "new/photo.jpg"]);
        expect(clashes.map((clash) => [clash.path, clash.existingKind])).toEqual([
            ["album", "dir"]
        ]);
    });
});

describe("taking a name for a new file", () => {
    it("refuses a taken name under fail, and leaves the file there alone", async () => {
        const { driver, files } = memoryDriver({ files: { "a.txt": "old" } });
        await expect(claimFileName(driver, "a.txt", "fail")).rejects.toBeInstanceOf(
            NameConflictError
        );
        expect(files.get("a.txt")).toBe("old");
    });

    it("refuses a name taken in another case on a storage that ignores case", async () => {
        const { driver, files } = memoryDriver(
            { files: { "A.TXT": "old" } },
            { caseInsensitive: true }
        );
        await expect(claimFileName(driver, "a.txt", "fail")).rejects.toBeInstanceOf(
            NameConflictError
        );
        expect(files.get("A.TXT")).toBe("old");
    });

    it("keeps both as name (1).ext, then (2)", async () => {
        const { driver } = memoryDriver({ files: { "a.txt": "old", "a (1).txt": "older" } });
        expect(await claimFileName(driver, "a.txt", "keepBoth")).toBe("a (2).txt");
    });

    it("counts a different-case name as taken when keeping both", async () => {
        const { driver } = memoryDriver({ files: { "Notes.md": "x", "notes (1).MD": "y" } });
        expect(await claimFileName(driver, "notes.md", "keepBoth")).toBe("notes (2).md");
    });

    it("lets exactly one of two racing writers take a free name", async () => {
        const { driver } = memoryDriver();
        const results = await Promise.allSettled([
            claimFileName(driver, "race.txt", "fail"),
            claimFileName(driver, "race.txt", "fail")
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const lost = results.find((result) => result.status === "rejected");
        expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(NameConflictError);
    });

    it("gives two racing keep-both writers different names", async () => {
        const { driver } = memoryDriver({ files: { "a.txt": "old" } });
        const names = await Promise.all([
            claimFileName(driver, "a.txt", "keepBoth"),
            claimFileName(driver, "a.txt", "keepBoth")
        ]);
        expect(new Set(names)).toEqual(new Set(["a (1).txt", "a (2).txt"]));
    });
});

describe("replacing", () => {
    it("puts the old file in the bin and the new one under the name", async () => {
        const { driver, files } = memoryDriver({ files: { "a.txt": "old", ".staged": "new" } });
        const trash = vi.fn(async (path: string) => {
            files.delete(path);
        });
        await replaceWith(driver, ".staged", "a.txt", { trash });
        expect(trash).toHaveBeenCalledWith("a.txt");
        expect(files.get("a.txt")).toBe("new");
        expect(files.has(".staged")).toBe(false);
    });

    it("retires the file by its own spelling when the name differs only in case", async () => {
        const { driver, files } = memoryDriver({
            files: { "Report.pdf": "old", ".staged": "new" }
        });
        const trash = vi.fn(async (path: string) => {
            files.delete(path);
        });
        await replaceWith(driver, ".staged", "report.pdf", { trash });
        expect(trash).toHaveBeenCalledWith("Report.pdf");
        expect([...files.keys()]).toEqual(["report.pdf"]);
    });

    it("without a bin, drops the old file only once the new one is in place", async () => {
        const { driver, files } = memoryDriver({ files: { "a.txt": "old", ".staged": "new" } });
        await replaceWith(driver, ".staged", "a.txt", { trash: null });
        expect([...files.entries()]).toEqual([["a.txt", "new"]]);
    });

    it("without a bin, puts the old file back when the swap fails", async () => {
        const { driver, files } = memoryDriver(
            { files: { "a.txt": "old", ".staged": "new" } },
            { failMoveFrom: ".staged" }
        );
        await expect(replaceWith(driver, ".staged", "a.txt", { trash: null })).rejects.toThrow();
        expect(files.get("a.txt")).toBe("old");
    });

    it("never replaces a folder with a file", async () => {
        const { driver, dirs } = memoryDriver({ files: { ".staged": "new" }, dirs: ["a.txt"] });
        const trash = vi.fn();
        await expect(replaceWith(driver, ".staged", "a.txt", { trash })).rejects.toBeInstanceOf(
            NameConflictError
        );
        expect(trash).not.toHaveBeenCalled();
        expect(dirs.has("a.txt")).toBe(true);
    });

    it("stops when the guard refuses the file that holds the name now", async () => {
        const { driver, files } = memoryDriver({ files: { "a.txt": "old", ".staged": "new" } });
        const trash = vi.fn();
        const guard = vi.fn(async () => {
            throw new Error("not yours");
        });
        await expect(replaceWith(driver, ".staged", "a.txt", { guard, trash })).rejects.toThrow(
            "not yours"
        );
        expect(trash).not.toHaveBeenCalled();
        expect(files.get("a.txt")).toBe("old");
    });
});

describe("folders and moves", () => {
    it("keeps both folders by making the new one as name (1)", async () => {
        const { driver, dirs } = memoryDriver({ dirs: ["album"] });
        expect(await claimFolderName(driver, "album", "keepBoth")).toBe("album (1)");
        expect(dirs.has("album (1)")).toBe(true);
    });

    it("moves under a free name instead of over the file there", async () => {
        const { driver, files } = memoryDriver({
            files: { "a/x.txt": "moving", "b/x.txt": "staying" },
            dirs: ["a", "b"]
        });
        expect(await moveToName(driver, "a/x.txt", "b/x.txt", "keepBoth")).toBe("b/x (1).txt");
        expect(files.get("b/x.txt")).toBe("staying");
        expect(files.get("b/x (1).txt")).toBe("moving");
    });

    it("refuses a move onto a taken name under fail", async () => {
        const { driver, files } = memoryDriver({
            files: { "a/x.txt": "moving", "b/x.txt": "staying" },
            dirs: ["a", "b"]
        });
        await expect(moveToName(driver, "a/x.txt", "b/x.txt", "fail")).rejects.toBeInstanceOf(
            NameConflictError
        );
        expect(files.get("b/x.txt")).toBe("staying");
        expect(files.get("a/x.txt")).toBe("moving");
    });
});
