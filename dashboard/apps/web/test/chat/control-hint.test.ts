/**
 * Where the word over a call control goes: above the button, inside the window,
 * below it when there is no room above, and nowhere when the button is not on
 * screen.
 */

import { describe, expect, it } from "vitest";
import { placeHint } from "@/app/(app)/chat/control-hint";

const phone = { width: 390, height: 844 };
const button = (left: number, top: number) => ({
    left,
    top,
    bottom: top + 36,
    width: 36,
    height: 36
});

describe("placing a control hint", () => {
    it("centres it above the button", () => {
        const at = placeHint(button(177, 780), { width: 60, height: 24 }, phone);
        expect(at).toEqual({ left: 165, top: 750 });
    });

    it("keeps it inside a narrow window", () => {
        const left = placeHint(button(0, 780), { width: 200, height: 24 }, phone);
        expect(left?.left).toBe(8);
        const right = placeHint(button(354, 780), { width: 200, height: 24 }, phone);
        expect(right?.left).toBe(390 - 200 - 8);
    });

    it("flips below a button at the top of the window", () => {
        const at = placeHint(button(100, 4), { width: 60, height: 24 }, phone);
        expect(at?.top).toBe(4 + 36 + 6);
    });

    it("draws nothing for a button that is hidden or off screen", () => {
        const hidden = { left: 0, top: 0, bottom: 0, width: 0, height: 0 };
        expect(placeHint(hidden, { width: 60, height: 24 }, phone)).toBeNull();
        expect(placeHint(button(100, 900), { width: 60, height: 24 }, phone)).toBeNull();
    });
});
