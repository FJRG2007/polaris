/**
 * Hex and HSV.
 *
 * The case that matters is the round trip. A picker holds the colour it is
 * dragging in HSV and hands hex out; if reading that hex back moved the handle,
 * the colour would walk across the square while somebody looked at it - and it
 * would do it worst at the edges, where a colour is several HSV coordinates at
 * once and the drift is a visible jump.
 */

import { describe, expect, it } from "vitest";
import { hexToHsv, hexToRgb, hsvToHex, prefersDarkText } from "./colors.js";

describe("a colour", () => {
    it("comes back as itself", () => {
        for (const hex of [
            "#000000",
            "#ffffff",
            "#ff0000",
            "#00ff00",
            "#0000ff",
            "#5b8def",
            "#3fd0c9",
            "#e8c26a",
            "#7f7f7f",
            "#010203"
        ]) {
            const hsv = hexToHsv(hex);
            expect(hsv).not.toBeNull();
            expect(hsvToHex(hsv!)).toBe(hex);
        }
    });

    it("is read in either case, and with the short spelling somebody types", () => {
        expect(hexToRgb("#FFF")).toEqual({ red: 255, green: 255, blue: 255 });
        expect(hexToRgb("A1B2C3")).toEqual({ red: 161, green: 178, blue: 195 });
    });

    it("is nothing when it is not one", () => {
        for (const text of ["", "#", "blue", "#12345", "#1234567", "rgb(1,2,3)"]) {
            expect(hexToRgb(text)).toBeNull();
            expect(hexToHsv(text)).toBeNull();
        }
    });

    it("keeps the hue it was dragged to when there is no colour left to see it in", () => {
        // Black is every hue at once. The conversion must not invent one, and the
        // picker holds its own so the handle does not jump back to red.
        expect(hexToHsv("#000000")).toEqual({ hue: 0, saturation: 0, value: 0 });
        expect(hsvToHex({ hue: 200, saturation: 80, value: 0 })).toBe("#000000");
    });

    it("wraps a hue past the turn", () => {
        expect(hsvToHex({ hue: 360, saturation: 100, value: 100 })).toBe("#ff0000");
        expect(hsvToHex({ hue: -60, saturation: 100, value: 100 })).toBe("#ff00ff");
    });
});

describe("text on a colour", () => {
    it("goes dark on a light one and light on a dark one", () => {
        expect(prefersDarkText("#ffffff")).toBe(true);
        expect(prefersDarkText("#f4dc9a")).toBe(true);
        expect(prefersDarkText("#20242c")).toBe(false);
        expect(prefersDarkText("#5b8def")).toBe(false);
    });
});
