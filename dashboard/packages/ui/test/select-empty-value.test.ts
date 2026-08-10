import { describe, expect, it } from "vitest";
import { fromRadixValue, toRadixValue } from "../src/components/select";

/**
 * "" is a value a select legitimately offers - "Any type", "Not set", "On demand
 * only" - and the one value Radix refuses to accept on an item, because it reserves
 * it for clearing the selection. Handing it one throws during render, which in this
 * app means the page is replaced by the error boundary.
 *
 * So the empty option travels under a name of its own and is translated back at both
 * edges. What matters is that the translation is total: a caller that passed "" gets
 * "" back, and no real value is altered on the way through.
 */
describe("the value an empty option travels under", () => {
    it("never hands Radix the string it refuses", () => {
        expect(toRadixValue("")).not.toBe("");
    });

    it("gives the caller back exactly what it passed", () => {
        for (const value of ["", "daily", "0", "false", "Any type"]) {
            expect(fromRadixValue(toRadixValue(value))).toBe(value);
        }
    });

    it("leaves every value that is not empty alone", () => {
        expect(toRadixValue("weekly")).toBe("weekly");
        expect(fromRadixValue("weekly")).toBe("weekly");
    });
});
