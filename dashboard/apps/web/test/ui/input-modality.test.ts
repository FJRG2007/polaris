// @vitest-environment jsdom

/**
 * The focus ring follows the keyboard, never a finger: the document records
 * which kind of input came last, and the stylesheet hides the ring after a tap
 * (the chat's "+" kept a circle around it once its sheet closed).
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INPUT_MODALITY_SCRIPT, watchInputModality } from "@/lib/input-modality";

function press(type: "pointerdown", pointerType: string): void {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    window.dispatchEvent(event);
}

describe("the last input the person used", () => {
    watchInputModality();
    const input = () => document.documentElement.dataset.input;

    it("is a touch after a tap", () => {
        press("pointerdown", "touch");
        expect(input()).toBe("touch");
    });

    it("is the keyboard after a key, but not after a modifier on its own", () => {
        press("pointerdown", "touch");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
        expect(input()).toBe("touch");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        expect(input()).toBe("keyboard");
    });

    it("is the mouse after a click", () => {
        press("pointerdown", "mouse");
        expect(input()).toBe("mouse");
    });

    it("ships as a self-contained script for the document head", () => {
        expect(INPUT_MODALITY_SCRIPT.startsWith("(")).toBe(true);
        expect(() => new Function(INPUT_MODALITY_SCRIPT)).not.toThrow();
    });

    it("has the stylesheet drop the ring after a touch", () => {
        const css = readFileSync(resolve(__dirname, "../../../../packages/ui/src/styles/tokens.css"), "utf8");
        expect(css).toMatch(/html\[data-input="touch"\][^{]*:focus-visible\s*\{[^}]*outline: none/);
    });
});
