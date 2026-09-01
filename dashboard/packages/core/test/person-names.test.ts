/**
 * Writing a person's name down the same way wherever it was typed.
 *
 * Split into two functions because of the caret, and that split is what these
 * pin. Capitalizing runs on every keystroke, so it must never change the length
 * of the string - a field that shortened what somebody had just typed would move
 * the caret backwards under their hands, mid-word. Tidying the spacing can change
 * the length, which is exactly why it waits for the blur.
 *
 * The other rule worth holding: only the first letter of each word is touched.
 * Lowercasing the rest turns McDonald into Mcdonald and O'Brien into O'brien,
 * which is worse than the problem being fixed - somebody who capitalized their
 * own name deliberately is right about their own name.
 */

import { describe, expect, it } from "vitest";
import { capitalizeWords, normalizePersonName } from "../src/names";

describe("capitalizing as somebody types", () => {
    it("never changes the length of what was typed", () => {
        // The whole reason this is safe on every keystroke. Trailing spaces,
        // double spaces and a half-typed word all have to survive intact.
        for (const typed of ["ada ", "ada  lovelace", "  ada", "j", "juan carlos ", "o'brien"]) {
            expect(capitalizeWords(typed)).toHaveLength(typed.length);
        }
    });

    it("capitalizes every word, not only the first", () => {
        expect(capitalizeWords("juan perez")).toBe("Juan Perez");
    });

    it("capitalizes the word being typed, letter by letter", () => {
        expect(capitalizeWords("ada l")).toBe("Ada L");
        expect(capitalizeWords("ada lo")).toBe("Ada Lo");
    });

    it("leaves a capital somebody chose alone", () => {
        expect(capitalizeWords("McDonald")).toBe("McDonald");
        expect(capitalizeWords("O'Brien")).toBe("O'Brien");
        expect(capitalizeWords("van der Berg")).toBe("Van Der Berg");
    });

    it("treats an apostrophe and a hyphen as the start of a word", () => {
        expect(capitalizeWords("o'brien")).toBe("O'Brien");
        expect(capitalizeWords("anne-marie")).toBe("Anne-Marie");
    });

    it("capitalizes a letter that is not in the Latin alphabet", () => {
        expect(capitalizeWords("ángela ríos")).toBe("Ángela Ríos");
    });

    it("leaves an empty field empty", () => {
        expect(capitalizeWords("")).toBe("");
        expect(capitalizeWords("   ")).toBe("   ");
    });
});

describe("tidying the name once they leave the field", () => {
    it("trims and collapses the spacing as well as capitalizing", () => {
        expect(normalizePersonName("  juan   carlos  ")).toBe("Juan Carlos");
    });

    it("agrees with the typing pass on anything already tidy", () => {
        // The two must not disagree, or a name would change on blur for no
        // reason a person could see.
        for (const name of ["Ada Lovelace", "O'Brien", "Anne-Marie", "McDonald"]) {
            expect(normalizePersonName(name)).toBe(capitalizeWords(name));
        }
    });

    it("turns a field of spaces into an empty one", () => {
        expect(normalizePersonName("   ")).toBe("");
    });
});
