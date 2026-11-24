/**
 * The overlay layer's panels: where each was left is kept and read back, a
 * widget dragged before there was a layer keeps its place, and a panel stays
 * whole on its display at a width it allows.
 */

import { describe, expect, it } from "vitest";
import {
    MAX_PANELS,
    clampInside,
    clampWidth,
    displayFor,
    layoutSchema,
    placeOf,
    placeReportSchema,
    voicePlace,
    withPlace
} from "@/shared/overlay-layout";

describe("a kept layout", () => {
    it("keeps one place per panel and forgets one on null", () => {
        const one = withPlace([], "voice", { x: 10, y: 20 });
        const moved = withPlace(one, "voice", { x: 30, y: 40, width: 300 });
        expect(moved).toEqual([{ id: "voice", x: 30, y: 40, width: 300 }]);
        expect(placeOf(moved, "voice")).toEqual({ id: "voice", x: 30, y: 40, width: 300 });
        expect(withPlace(moved, "voice", null)).toEqual([]);
        expect(placeOf([], "voice")).toBeNull();
    });

    it("holds no more panels than it may", () => {
        let layout = withPlace([], "a0", { x: 0, y: 0 });
        for (let index = 1; index < MAX_PANELS + 5; index += 1) layout = withPlace(layout, `a${index}`, { x: index, y: index });
        expect(layout).toHaveLength(MAX_PANELS);
        expect(layoutSchema.safeParse(layout).success).toBe(true);
    });

    it("reads a panel a newer app knows, and refuses what is not a place", () => {
        expect(layoutSchema.safeParse([{ id: "streams", x: -1920, y: 0, width: 400, height: 300 }]).success).toBe(true);
        expect(layoutSchema.safeParse([{ id: "voice", x: 1.5, y: 0 }]).success).toBe(false);
        expect(layoutSchema.safeParse([{ id: "voice", x: 0, y: 0, width: 0 }]).success).toBe(false);
        expect(layoutSchema.safeParse([{ id: "", x: 0, y: 0 }]).success).toBe(false);
    });
});

describe("the voice panel's place", () => {
    it("is the layout's when there is one", () => {
        expect(voicePlace([{ id: "voice", x: 5, y: 6, width: 300 }], { x: 1, y: 2 })).toEqual({ id: "voice", x: 5, y: 6, width: 300 });
    });

    it("is where the widget was dragged before there was a layer", () => {
        expect(voicePlace([], { x: 1, y: 2 })).toEqual({ id: "voice", x: 1, y: 2 });
    });

    it("is none for a widget never moved, so it takes its corner", () => {
        expect(voicePlace([{ id: "chat", x: 0, y: 0 }], null)).toBeNull();
    });
});

describe("a panel on its display", () => {
    const displays = [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } }
    ];

    it("is on the display its corner is on, or none", () => {
        expect(displayFor({ x: 16, y: 16 }, displays)?.id).toBe(1);
        expect(displayFor({ x: -100, y: 500 }, displays)?.id).toBe(2);
        expect(displayFor({ x: 5000, y: 16 }, displays)).toBeNull();
    });

    it("stays whole inside the layer", () => {
        const area = { x: 0, y: 0, width: 1920, height: 1080 };
        expect(clampInside({ x: 1900, y: 1070, width: 240, height: 100 }, area)).toEqual({ x: 1680, y: 980 });
        expect(clampInside({ x: -50, y: -50, width: 240, height: 100 }, area)).toEqual({ x: 0, y: 0 });
        expect(clampInside({ x: 100, y: 100, width: 3000, height: 100 }, area)).toEqual({ x: 0, y: 100 });
    });

    it("is as wide as it allows, grown with the text size", () => {
        expect(clampWidth("voice", 50, 1)).toBe(160);
        expect(clampWidth("voice", 9999, 1)).toBe(480);
        expect(clampWidth("voice", 9999, 1.25)).toBe(600);
        expect(clampWidth("voice", 300.4, 1)).toBe(300);
    });
});

describe("a place the layer reports", () => {
    it("names a panel there is and a whole rectangle", () => {
        expect(placeReportSchema.safeParse({ id: "voice", x: 1, y: 2, width: 3, height: 4, sized: false }).success).toBe(true);
        expect(placeReportSchema.safeParse({ id: "voice", x: 1, y: 2, width: 3, height: 4 }).success).toBe(false);
        expect(placeReportSchema.safeParse({ id: "voice", x: 1, y: 2, width: 3, height: 4, sized: false, extra: 1 }).success).toBe(false);
    });
});
