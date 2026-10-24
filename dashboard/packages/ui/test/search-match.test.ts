import { describe, expect, it } from "vitest";
import { groupRows, highlightRanges, searchTerms, stepActive } from "../src/search/search-match";

const marked = (text: string, terms: string[]) =>
    highlightRanges(text, terms).map(([start, end]) => text.slice(start, end));

describe("search panel keys", () => {
    it("moves down and up, wrapping at either end", () => {
        expect(stepActive("ArrowDown", 0, 3)).toBe(1);
        expect(stepActive("ArrowDown", 2, 3)).toBe(0);
        expect(stepActive("ArrowUp", 0, 3)).toBe(2);
        expect(stepActive("Home", 2, 3)).toBe(0);
        expect(stepActive("End", 0, 3)).toBe(2);
    });

    it("stays put on an empty list and ignores other keys", () => {
        expect(stepActive("ArrowDown", 0, 0)).toBe(0);
        expect(stepActive("End", 0, 0)).toBe(0);
        expect(stepActive("a", 1, 3)).toBeNull();
        expect(stepActive("Enter", 1, 3)).toBeNull();
    });

    it("groups consecutive rows under their label, keeping each row's place", () => {
        const groups = groupRows(["a1", "a2", "b1", "a3"], (row) => row[0]!);
        expect(groups.map((group) => group.label)).toEqual(["a", "b", "a"]);
        expect(groups[1]!.rows).toEqual([{ row: "b1", position: 2 }]);
    });
});

describe("highlighted matches", () => {
    it("marks the start or the middle of a word, without case or accents", () => {
        expect(marked("Archivos y reenvío", ["reenv"])).toEqual(["reenv"]);
        expect(marked("Reenvío", ["reenvio"])).toEqual(["Reenvío"]);
        expect(marked("Password manager", ["word"])).toEqual(["word"]);
    });

    it("marks a whole word a term is a forgivable typo of", () => {
        expect(marked("Versions of a file", ["verisons"])).toEqual(["Versions"]);
        expect(marked("cat car", ["cap"])).toEqual([]);
    });

    it("returns nothing to mark for no terms or no text", () => {
        expect(highlightRanges("text", [])).toEqual([]);
        expect(highlightRanges("", ["a"])).toEqual([]);
    });

    it("splits a query into folded words", () => {
        expect(searchTerms("  Canción  DE prueba ")).toEqual(["cancion", "de", "prueba"]);
    });
});
