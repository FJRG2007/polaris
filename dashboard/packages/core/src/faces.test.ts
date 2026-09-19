import { describe, expect, it } from "vitest";
import { firstName, greetingFor, initials, tintFor } from "./faces.js";

const at = (hour: number) => new Date(2026, 8, 19, hour, 0, 0);

describe("the greeting", () => {
    it("follows the reader's clock", () => {
        expect(greetingFor(at(3))).toBe("Good night");
        expect(greetingFor(at(9))).toBe("Good morning");
        expect(greetingFor(at(15))).toBe("Good afternoon");
        expect(greetingFor(at(21))).toBe("Good evening");
    });

    it("addresses the first name", () => {
        expect(firstName("  Ada Lovelace ")).toBe("Ada");
        expect(firstName("")).toBe("");
    });
});

describe("a face without a photo", () => {
    it("takes two letters", () => {
        expect(initials("Ada Lovelace")).toBe("AL");
        expect(initials("ada")).toBe("AD");
        expect(initials("  ")).toBe("?");
    });

    it("keeps one colour per id", () => {
        expect(tintFor("abc")).toBe(tintFor("abc"));
        expect(tintFor("abc")).toMatch(/^hsl\(\d+ 36% 42%\)$/);
    });
});
