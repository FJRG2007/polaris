/**
 * Where a person's card opens.
 *
 * Beside what was pressed, level with it; on the left when the right has no
 * room; underneath when neither side has; and always wholly on screen, because
 * a card cut off by the edge of the window hides its buttons.
 */

import { describe, expect, it } from "vitest";
import { placeCard } from "@/app/(app)/chat/card-placement";

const VIEW = { width: 1280, height: 800 };
const CARD = { width: 288, height: 360 };

function at(left: number, top: number, width = 80, height = 20) {
    return { left, top, right: left + width, bottom: top + height };
}

describe("placing a card", () => {
    it("opens to the right of a name, level with it", () => {
        expect(placeCard(at(100, 200), CARD, VIEW)).toEqual({ left: 188, top: 200 });
    });

    it("opens to the left of a name at the right-hand edge, as in the roster", () => {
        expect(placeCard(at(1150, 200), CARD, VIEW)).toEqual({ left: 1150 - 8 - 288, top: 200 });
    });

    it("moves up rather than hang off the bottom of the window", () => {
        expect(placeCard(at(100, 700), CARD, VIEW).top).toBe(800 - 8 - 360);
    });

    it("goes underneath when neither side has room, which is a phone", () => {
        const phone = { width: 390, height: 800 };
        const place = placeCard(at(40, 100, 200), CARD, phone);
        expect(place.top).toBe(128);
        expect(place.left + CARD.width).toBeLessThanOrEqual(390 - 8);
    });

    it("goes above on a phone when there is no room underneath", () => {
        const phone = { width: 390, height: 800 };
        expect(placeCard(at(40, 700, 200), CARD, phone).top).toBe(700 - 8 - 360);
    });

    it("starts at the top when it is taller than the window, where the name is", () => {
        expect(placeCard(at(100, 300), { width: 288, height: 900 }, VIEW).top).toBe(8);
    });
});
