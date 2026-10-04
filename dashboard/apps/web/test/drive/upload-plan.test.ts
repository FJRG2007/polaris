/**
 * From picked files and the answers about taken names to the uploads sent.
 *
 * A skipped folder takes its files with it, a folder kept as both sends its
 * files under the new name, a merged folder's files carry their own answers,
 * and anything nobody was asked about goes as `fail` - so a name somebody takes
 * meanwhile is a question, never an overwrite.
 */

import { describe, expect, it } from "vitest";
import type { UploadItem } from "@/lib/drop-items";
import {
    conflictIn,
    planUploads,
    topLevelEntries,
    uploadConflictFor
} from "../../src/app/(app)/drive/upload-plan";

function item(relPath: string): UploadItem {
    return { file: new File(["x"], relPath.split("/").pop() ?? relPath), relPath };
}

const picked = [item("a.txt"), item("album/one.jpg"), item("album/two.jpg"), item("trip/day.jpg")];

describe("planning an upload", () => {
    it("checks each file and each top folder once", () => {
        expect(topLevelEntries(picked)).toEqual([
            { path: "a.txt", kind: "file" },
            { path: "album", kind: "dir" },
            { path: "trip", kind: "dir" }
        ]);
    });

    it("sends what nobody was asked about as fail", () => {
        expect(planUploads(picked, new Map(), new Map()).map((step) => step.conflict)).toEqual([
            "fail",
            "fail",
            "fail",
            "fail"
        ]);
    });

    it("drops a skipped folder with its files, and renames a folder kept as both", () => {
        const plan = planUploads(
            picked,
            new Map([
                ["album", "skip"],
                ["trip", "keepBoth"],
                ["a.txt", "replace"]
            ]),
            new Map([["trip", "trip (1)"]])
        );
        expect(plan.map((step) => [step.relPath, step.conflict])).toEqual([
            ["a.txt", "replace"],
            ["trip (1)/day.jpg", "fail"]
        ]);
    });

    it("gives the files of a merged folder their own answers", () => {
        const plan = planUploads(
            picked,
            new Map([
                ["album", "merge"],
                ["album/one.jpg", "keepBoth"],
                ["album/two.jpg", "skip"]
            ]),
            new Map()
        );
        expect(plan.map((step) => [step.relPath, step.conflict])).toEqual([
            ["a.txt", "fail"],
            ["album/one.jpg", "keepBoth"],
            ["trip/day.jpg", "fail"]
        ]);
    });

    it("maps the answers to what the route is told", () => {
        expect(uploadConflictFor(undefined)).toBe("fail");
        expect(uploadConflictFor("keepBoth")).toBe("keepBoth");
        expect(uploadConflictFor("replace")).toBe("replace");
    });
});

describe("reading a 409", () => {
    it("takes the clash out of the route's answer", () => {
        const clash = {
            path: "a.txt",
            incomingKind: "file",
            existingName: "A.txt",
            existingKind: "file",
            canReplace: true,
            replaceBlocked: null,
            recoverable: true
        };
        expect(conflictIn(JSON.stringify({ error: "name_conflict", clash }))).toEqual(clash);
    });

    it("is null for any other body", () => {
        expect(conflictIn("Locked")).toBeNull();
        expect(conflictIn(JSON.stringify({ error: "other" }))).toBeNull();
    });
});
