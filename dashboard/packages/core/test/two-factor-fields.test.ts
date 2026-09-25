import { describe, expect, it } from "vitest";
import { otpCodeField, phoneField } from "../src/schemas/two-factor.js";

describe("phoneField", () => {
    it("keeps a number in international form", () => {
        expect(phoneField.parse("+34600111222")).toBe("+34600111222");
    });

    it("drops the spaces, dashes and brackets a number is copied with", () => {
        expect(phoneField.parse(" +34 600 11 12 22 ")).toBe("+34600111222");
        expect(phoneField.parse("+1 (415) 555-0100")).toBe("+14155550100");
    });

    it("refuses a number without its prefix, and anything with letters", () => {
        expect(phoneField.safeParse("600111222").success).toBe(false);
        expect(phoneField.safeParse("+34a").success).toBe(false);
        expect(phoneField.safeParse("a").success).toBe(false);
        expect(phoneField.safeParse("+3460011122a").success).toBe(false);
    });
});

describe("otpCodeField", () => {
    it("takes six digits and nothing else", () => {
        expect(otpCodeField.safeParse("123456").success).toBe(true);
        expect(otpCodeField.safeParse("12345").success).toBe(false);
        expect(otpCodeField.safeParse("12345a").success).toBe(false);
    });
});
