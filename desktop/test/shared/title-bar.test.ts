import { describe, expect, it } from "vitest";
import { hexOf, symbolFor, titleBarColorsSchema } from "@/shared/title-bar";

describe("title bar colours", () => {
    it("reads an opaque computed colour as hex", () => {
        expect(hexOf("rgb(16, 17, 20)")).toBe("#101114");
        expect(hexOf("rgba(255, 255, 255, 1)")).toBe("#ffffff");
        expect(hexOf("rgb(16 17 20 / 100%)")).toBe("#101114");
    });

    it("passes over what is see-through, so the walk goes on to the parent", () => {
        expect(hexOf("rgba(0, 0, 0, 0)")).toBeNull();
        expect(hexOf("rgb(16 17 20 / 50%)")).toBeNull();
        expect(hexOf("transparent")).toBeNull();
    });

    it("puts light symbols on a dark header and dark ones on a light header", () => {
        expect(symbolFor("#101114")).toBe("#e6e7ea");
        expect(symbolFor("#ffffff")).toBe("#1c1d21");
    });

    it("refuses anything but two hex colours from the page", () => {
        expect(titleBarColorsSchema.safeParse({ background: "#101114", symbol: "#e6e7ea" }).success).toBe(true);
        expect(titleBarColorsSchema.safeParse({ background: "red", symbol: "#e6e7ea" }).success).toBe(false);
    });
});
