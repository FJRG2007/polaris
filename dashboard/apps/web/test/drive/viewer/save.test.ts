/** Naming and validation for the viewer's save actions. */

import { describe, expect, it } from "vitest";
import {
    copyNameFor,
    fileNameSchema,
    withExtension
} from "../../../src/app/(app)/drive/viewer/save";

describe("copyNameFor", () => {
    it("suffixes before the extension", () => {
        expect(copyNameFor("Report.xlsx")).toBe("Report copy.xlsx");
        expect(copyNameFor("notes")).toBe("notes copy");
        expect(copyNameFor(".gitignore")).toBe(".gitignore copy");
    });

    it("swaps the extension when the editor writes another format", () => {
        expect(copyNameFor("Book.xls", "xlsx")).toBe("Book copy.xlsx");
    });
});

describe("withExtension", () => {
    it("replaces the extension", () => {
        expect(withExtension("Book.xls", "xlsx")).toBe("Book.xlsx");
        expect(withExtension("Book", "xlsx")).toBe("Book.xlsx");
    });
});

describe("fileNameSchema", () => {
    it("accepts a normal name and trims it", () => {
        expect(fileNameSchema.parse("  Report copy.xlsx ")).toBe("Report copy.xlsx");
    });

    it("rejects paths, reserved names and control characters", () => {
        const invalid = [
            "",
            "   ",
            ".",
            "..",
            "a/b.txt",
            "a\\b.txt",
            'q"x.txt',
            "a:b.txt",
            "a*b.txt",
            `bad${String.fromCharCode(7)}name.txt`,
            "a".repeat(256)
        ];
        for (const name of invalid) {
            expect(fileNameSchema.safeParse(name).success, name).toBe(false);
        }
    });
});
