/**
 * What a screen is allowed to be told when something goes wrong.
 *
 * A camera would not save, and what the person adding it was shown was a Prisma
 * invocation complaining about a uuid column. That is a sentence which helps
 * nobody, describes the schema to anyone passing, and had a real bug behind it
 * that nobody could have guessed from the words.
 *
 * So the rule: only a refusal somebody wrote is shown. Everything else is a
 * fault, goes to the log whole, and reaches the screen as a plain sentence.
 */

import { describe, expect, it } from "vitest";
import { HomeError } from "@/lib/home/home-error";

/** The guard the Places actions use, to the letter. */
async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof HomeError) return { error: caught.message };
        return { error: "That did not work. Nothing was changed." };
    }
}

describe("what reaches the screen", () => {
    it("shows a refusal that was written to be read", async () => {
        const result = await guard(async () => {
            throw new HomeError("An area on this camera is already called that.");
        });
        expect(result.error).toBe("An area on this camera is already called that.");
    });

    it("never shows what a database said", async () => {
        // The exact shape that got through: a driver explaining a column.
        const said = await guard(async () => {
            throw new Error(
                "Invalid `prisma.camera.update()` invocation: Inconsistent column data: " +
                    "Error creating UUID, invalid character: expected an optional prefix of " +
                    "`urn:uuid:` followed by [0-9a-fA-F-], found `l` at 1"
            );
        });
        expect(said.error).toBe("That did not work. Nothing was changed.");
        expect(said.error).not.toContain("prisma");
        expect(said.error).not.toContain("UUID");
    });

    it("never shows a fault that is not even an Error", async () => {
        const result = await guard(async () => {
            throw "something threw a string";
        });
        expect(result.error).toBe("That did not work. Nothing was changed.");
    });

    it("passes a value straight through when nothing went wrong", async () => {
        expect(await guard(async () => 7)).toEqual({ value: 7 });
    });
});
