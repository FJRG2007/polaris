/**
 * An import is driven from the screen, a slice at a time, and every one of those
 * calls carries the place to start from.
 *
 * Which makes that number a request like any other. Taken unchecked it reached
 * the slice as `NaN`, and a slice from nowhere is empty - so the batch appended
 * nothing, answered that it had reached the end of the archive, and the screen
 * reported an import that had imported nothing as finished. That is the one
 * failure an import must not have.
 */

import { describe, expect, it } from "vitest";
import { mailImportFromSchema, mailImportSchema } from "./mailbox.js";

const TARGET = {
    accountId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    folderId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    uploadId: "3f2504e0-4f89-41d3-9a0c-0305e82c3303"
};

describe("what an import may be aimed at", () => {
    it("takes three ids and nothing else", () => {
        expect(mailImportSchema.safeParse(TARGET).success).toBe(true);
    });

    it("refuses anything that is not one", () => {
        for (const wrong of [
            { ...TARGET, accountId: "" },
            { ...TARGET, folderId: "../../etc" },
            { ...TARGET, uploadId: 7 },
            {},
            null
        ]) {
            expect(mailImportSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
        }
    });
});

describe("where the next slice starts", () => {
    it("reads a number, however the action encoded it", () => {
        expect(mailImportFromSchema.parse(25)).toBe(25);
        expect(mailImportFromSchema.parse("25")).toBe(25);
        expect(mailImportFromSchema.parse(undefined)).toBe(0);
    });

    it("refuses the values that silently ended an import", () => {
        for (const wrong of [Number.NaN, -1, 1.5, "a while in", {}]) {
            expect(mailImportFromSchema.safeParse(wrong).success, String(wrong)).toBe(false);
        }
    });
});
