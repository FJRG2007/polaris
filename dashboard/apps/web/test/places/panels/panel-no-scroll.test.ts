/**
 * A wall card never scrolls inside itself: what does not fit opens full screen
 * instead. Read off the source, so a scrolling box added to any card later
 * fails here rather than on somebody's wall.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CARD_FILES = [
    "panel-cards.tsx",
    "panel-fit-grid.tsx",
    "panel-weather.tsx"
];

const source = (file: string) =>
    readFileSync(
        new URL(`../../../../places/src/screens/panels/${file}`, import.meta.url),
        "utf8"
    );

describe("wall panel cards", () => {
    it.each(CARD_FILES)("%s has no scrolling box", (file) => {
        expect(source(file)).not.toMatch(/overflow(-[xy])?-(auto|scroll)|overscroll-/);
    });

    it.each(CARD_FILES)("%s draws no text smaller than the base size", (file) => {
        expect(source(file)).not.toMatch(/\btext-(xs|sm|\[0\.\d+rem\])\b/);
    });
});
