import { describe, expect, it } from "vitest";
import { contrastRatio, INK_LIGHT } from "./contrast.js";
import {
    INITIALS_INK_DARK,
    firstName,
    greetingFor,
    initials,
    initialsInk,
    tintFor
} from "./faces.js";

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

describe("the initials' ink", () => {
    it("reads at 4.5:1 or better on every tint in the palette", () => {
        // tintFor is `hsl(hash % 360 36% 42%)`: these 360 are every tint it gives.
        const failing: string[] = [];
        for (let hue = 0; hue < 360; hue += 1) {
            const tint = `hsl(${hue} 36% 42%)`;
            const ratio = contrastRatio(initialsInk(tint), tint);
            if (ratio < 4.5) failing.push(`${tint}: ${ratio.toFixed(2)}`);
        }
        expect(failing).toEqual([]);
    });

    it("reads at 4.5:1 on the tint of any id, through tintFor itself", () => {
        for (const id of ["u1", "ada@example.com", "o-42", "Prometheus", ""]) {
            const tint = tintFor(id);
            expect(contrastRatio(initialsInk(tint), tint)).toBeGreaterThanOrEqual(4.5);
        }
    });

    it("is white where white reads, and black on the yellows where it does not", () => {
        expect(initialsInk("hsl(240 36% 42%)")).toBe(INK_LIGHT);
        expect(initialsInk("hsl(60 36% 42%)")).toBe(INITIALS_INK_DARK);
        expect(initialsInk("#4f46e5")).toBe(INK_LIGHT);
        expect(initialsInk("#fde047")).toBe(INITIALS_INK_DARK);
    });

    it("keeps white for a fill it cannot read", () => {
        expect(initialsInk("transparent")).toBe(INK_LIGHT);
    });
});
