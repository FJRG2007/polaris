/**
 * The decorations that are drawings rather than rings.
 *
 * The catalogue could only make rings, arcs and beads - parameters around a
 * circle - so everything in it was a variation on a border. What people actually
 * want beside their name is a thing: a cat asleep on their head, a pair of
 * wings, a hat. Those needed a layer that carries shapes, and they break the one
 * rule every other decoration keeps, which is why they are checked separately.
 *
 * Two properties, and both of them are about not ruining a list of thirty faces:
 * a worn thing is drawn over the photograph rather than behind it, and it is
 * perfectly still until somebody points at it.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarDecorationArt } from "@/components/avatar-decoration";
import { AVATAR_DECORATIONS, decorationOf, decorationMoves } from "@polaris/core";

function pass(id: string, front: boolean): string {
    return renderToStaticMarkup(
        <AvatarDecorationArt decoration={decorationOf(id)!} front={front} />
    );
}

/** The ones made of shapes rather than of a radius and a thickness. */
const WORN = AVATAR_DECORATIONS.filter((decoration) =>
    decoration.layers.some((layer) => layer.kind === "art")
);

describe("a decoration that is a drawing", () => {
    it("exists, because a catalogue of rings is a catalogue of one idea", () => {
        expect(WORN.map((decoration) => decoration.id)).toContain("cat");
    });

    it("is drawn over the photograph, not behind it", () => {
        // Behind, a cat resting on the rim is two ears and no cat: the face
        // covers everything inside the band, which is most of it.
        for (const decoration of WORN) {
            expect(pass(decoration.id, true)).toContain("<svg");
        }
    });

    it("draws nothing at all on the pass it has no layers for", () => {
        // Most decorations have no front half, and an empty overlay on every
        // face in a list is thirty nodes that paint nothing.
        expect(pass("aurora", true)).toBe("");
    });

    it("is still until somebody points at it", () => {
        // Not a paused animation resumed on hover: a paused animation still
        // holds a layer for every face on the screen, which is the cost this
        // avoids. The rule lives in the stylesheet, under `.profile-worn:hover`,
        // so what is asserted here is that the drawing asks for it.
        const html = pass("cat", true);
        expect(html).toMatch(/profile-wake-(sway|bob)/);
        expect(html).not.toContain("animateTransform");
    });

    it("says out loud that it moves", () => {
        // Somebody who turns movement off is saying they do not want to be
        // surprised by it, and "only when you touch it" is still a surprise. The
        // picker prints this, so it has to count.
        expect(decorationMoves(decorationOf("cat")!)).toBe(true);
    });

    it("draws each mark it was given", () => {
        const html = pass("cat", true);
        const marks = (html.match(/<(circle|path|ellipse)\b/g) ?? []).length;
        // Two ears, two inner ears, and the shadow where each meets the head.
        // Ears rather than a whole animal: at the size a face is drawn in a
        // member list, a cat is a smudge with a tail, and two triangles at the
        // right angle read as one at twenty pixels.
        expect(marks).toBeGreaterThanOrEqual(6);
    });

    it("never leaves the box the overlay paints in", () => {
        // The rule that replaced "stay inside the circle" once the band moved
        // outside the face. The overlay is a square, a clipping ancestor cuts at
        // its edges, and the corners of it are perfectly good places for the tip
        // of a wing - which the circle rule forbade for no reason a reader could
        // see.
        for (const decoration of WORN) {
            for (const layer of decoration.layers) {
                if (layer.kind !== "art") continue;
                const [x, y, width, height] = layer.bounds;
                expect(x).toBeGreaterThanOrEqual(0);
                expect(y).toBeGreaterThanOrEqual(0);
                expect(x + width).toBeLessThanOrEqual(1);
                expect(y + height).toBeLessThanOrEqual(1);
            }
        }
    });
});
