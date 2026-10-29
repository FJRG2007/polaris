import { describe, expect, it } from "vitest";
import { foreignPageCss, hexOf, overlayHeight, symbolFor, titleBarColorsSchema } from "@/shared/title-bar";

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

    it("sizes the window buttons with the page zoom, so they stay level with the header", () => {
        expect(overlayHeight(1)).toBe(48);
        expect(overlayHeight(1.25)).toBe(60);
        expect(overlayHeight(0.8)).toBe(38);
        expect(overlayHeight(Number.NaN)).toBe(48);
        expect(overlayHeight(100)).toBe(240);
    });

    it("moves a provider's page below the buttons and lets the window be dragged above it", () => {
        const css = foreignPageCss("#101114");
        expect(css).toContain("padding-top: env(titlebar-area-height, 0px)");
        expect(css).toContain("app-region: drag");
        expect(css).toContain("background: #101114");
        expect(() => foreignPageCss("red; } body { display: none")).toThrow();
    });
});
