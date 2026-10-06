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

describe("a filter condition with several values", () => {
    it("keeps the values that say something, and the switch for capitals", async () => {
        const { mailFilterConditionSchema } = await import("./mailbox.js");
        const parsed = mailFilterConditionSchema.parse({
            id: "cond01",
            kind: "subject",
            operator: "contains",
            value: "PR run failed:",
            alternatives: ["  Run cancelled ", "", "   "],
            caseSensitive: true
        });
        expect(parsed).toMatchObject({
            value: "PR run failed:",
            alternatives: ["Run cancelled"],
            caseSensitive: true
        });
    });

    it("refuses more values, or capitals, where the comparison has none", async () => {
        const { mailFilterConditionSchema } = await import("./mailbox.js");
        expect(
            mailFilterConditionSchema.safeParse({
                id: "cond01",
                kind: "size",
                operator: "greater-than",
                value: "100",
                alternatives: ["200"]
            }).success
        ).toBe(false);
        expect(
            mailFilterConditionSchema.safeParse({
                id: "cond01",
                kind: "subject",
                operator: "matches",
                value: "ok",
                alternatives: ["(["]
            }).success
        ).toBe(false);
    });
});
