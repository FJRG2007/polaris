import { describe, expect, it } from "vitest";
import { composite, foreignPageCss, hexOf, overlayHeight, rgbaOf, symbolFor, titleBarColorsSchema } from "@/shared/title-bar";

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
        expect(overlayHeight(1)).toBe(47);
        expect(overlayHeight(1.25)).toBe(59);
        expect(overlayHeight(0.8)).toBe(37);
        expect(overlayHeight(Number.NaN)).toBe(47);
        expect(overlayHeight(100)).toBe(235);
    });

    it("moves a provider's page below the buttons and lets the window be dragged above it", () => {
        const css = foreignPageCss("#101114");
        expect(css).toContain("padding-top: env(titlebar-area-height, 0px)");
        expect(css).toContain("app-region: drag");
        expect(css).toContain("background: #101114");
        expect(() => foreignPageCss("red; } body { display: none")).toThrow();
    });

    it("paints the buttons the dimmed colour a dialog's backdrop makes, not the page under it", () => {
        // A white header under an 80% black backdrop is what the eye sees as
        // #333333; the first opaque layer alone would say #ffffff.
        const backdrop = rgbaOf("rgba(0, 0, 0, 0.8)")!;
        const header = rgbaOf("rgb(255, 255, 255)")!;
        expect(composite([backdrop, header])).toBe("#333333");
        expect(composite([header])).toBe("#ffffff");
    });

    it("waits for something opaque before it says a colour", () => {
        expect(composite([rgbaOf("rgba(0, 0, 0, 0.5)")!])).toBeNull();
        expect(composite([])).toBeNull();
    });

    it("reads the colour functions a computed style can come back as", () => {
        expect(rgbaOf("rgb(16 17 20 / 0.5)")).toEqual({ r: 16, g: 17, b: 20, a: 0.5 });
        expect(rgbaOf("color(srgb 1 0 0.5)")).toEqual({ r: 255, g: 0, b: 127.5, a: 1 });
        expect(rgbaOf("transparent")).toBeNull();
    });
});
