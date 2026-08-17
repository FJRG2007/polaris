/**
 * Getting out of a picture.
 *
 * The viewer used to hang the closing press on its outermost element, which
 * nothing can ever hit: the stage that holds the picture is stretched over the
 * whole area under the toolbar, so every press on the dark landed on the stage
 * and the only ways out were Escape and the X. The rule now lives on the stage,
 * and it has to keep telling a press apart from the end of a pan.
 */

import { describe, expect, it } from "vitest";
import { closesOnRelease } from "@/components/image-viewer";

const dark = { x: 100, y: 100, outside: true };
const picture = { x: 100, y: 100, outside: false };

describe("letting go in the viewer", () => {
    it("closes on a press in the dark around the picture", () => {
        expect(closesOnRelease(dark, { clientX: 100, clientY: 100 })).toBe(true);
    });

    it("forgives the wobble of a hand that meant to press", () => {
        expect(closesOnRelease(dark, { clientX: 102, clientY: 101 })).toBe(true);
    });

    it("stays open when the press was a drag", () => {
        expect(closesOnRelease(dark, { clientX: 260, clientY: 140 })).toBe(false);
    });

    it("stays open when the press started on the picture", () => {
        expect(closesOnRelease(picture, { clientX: 100, clientY: 100 })).toBe(false);
    });

    it("stays open when nothing was pressed here at all", () => {
        expect(closesOnRelease(null, { clientX: 100, clientY: 100 })).toBe(false);
    });
});
