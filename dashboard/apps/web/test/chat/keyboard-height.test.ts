/**
 * The "+" panel takes the keyboard's place at the keyboard's height: measured
 * whether the browser overlays the keyboard or the app's WebView resizes for it,
 * and a share of the screen until one has been seen.
 */

import { describe, expect, it } from "vitest";
import { measureKeyboard, sheetHeight } from "@/lib/chat/keyboard-height";

describe("the keyboard's height", () => {
    it("reads a keyboard laid over the page", () => {
        expect(measureKeyboard(800, 800, 480, 0)).toBe(320);
    });

    it("reads a keyboard the WebView resized for", () => {
        expect(measureKeyboard(800, 480, 480, 0)).toBe(320);
    });

    it("takes a sliding address bar for no keyboard", () => {
        expect(measureKeyboard(800, 800, 744, 0)).toBe(0);
    });
});

describe("the panel's height", () => {
    it("is the last keyboard's", () => {
        expect(sheetHeight(320, 800)).toBe(320);
    });

    it("is a share of the screen before any keyboard was seen", () => {
        expect(sheetHeight(0, 800)).toBe(320);
    });

    it("never hides the conversation behind it", () => {
        expect(sheetHeight(700, 800)).toBe(480);
    });
});
