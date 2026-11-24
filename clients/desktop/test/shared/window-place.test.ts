import { describe, expect, it } from "vitest";
import { restoredPlace } from "@/shared/window-place";

const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: -200, width: 2560, height: 1400 };

describe("where the window opens", () => {
    it("goes back to the second monitor, where it was", () => {
        const saved = { x: 2200, y: 100, width: 1000, height: 700, maximized: false };
        expect(restoredPlace(saved, [LEFT, RIGHT], LEFT)).toEqual(saved);
    });

    it("keeps being maximized", () => {
        const saved = { x: 100, y: 100, width: 1000, height: 700, maximized: true };
        expect(restoredPlace(saved, [LEFT], LEFT).maximized).toBe(true);
    });

    it("comes back to a monitor that exists when its own is gone", () => {
        const saved = { x: 3000, y: 100, width: 2400, height: 1300, maximized: false };
        expect(restoredPlace(saved, [LEFT], LEFT)).toEqual({
            width: 1920,
            height: 1040,
            maximized: false
        });
    });

    it("will not leave the title bar out of reach above a screen", () => {
        const saved = { x: 100, y: -600, width: 1000, height: 700, maximized: false };
        expect(restoredPlace(saved, [LEFT], LEFT).x).toBeUndefined();
    });
});
