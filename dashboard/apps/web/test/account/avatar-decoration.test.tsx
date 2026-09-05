/**
 * A decoration, once it is marks on a screen.
 *
 * The catalogue is checked in @polaris/core, where the geometry lives. What is
 * checked here is the drawing, and specifically the three ways it can be wrong
 * without looking wrong to whoever wrote it.
 *
 * A gradient is referenced by an id, and ids are document-wide: two faces on one
 * screen sharing one meant the second was painted in the first one's colours,
 * which nobody notices until two people pick different rings and see the same
 * one. React's own ids also carry colons, and a colon in a fragment reference is
 * something some browsers decline to resolve - a ring that simply does not paint.
 *
 * And movement has to be CSS. `prefers-reduced-motion` is honoured across the
 * product by one rule over every animation; an `<animateTransform>` would be the
 * single ornament in Polaris that kept turning for somebody who asked their
 * machine to stop everything.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarDecorationArt } from "@/components/avatar-decoration";
import { AVATAR_DECORATIONS, decorationOf, decorationMoves } from "@polaris/core";

/**
 * Both passes, as a face draws them.
 *
 * A decoration is drawn twice with the photograph in between: the rings go
 * behind, and a worn thing - a cat, a hat - goes on top, because resting on the
 * rim is the whole of what makes it worn. Either pass on its own is half a
 * decoration, and a check that only looked at the back one would have said the
 * cat drew nothing.
 */
function drawn(id: string): string {
    const decoration = decorationOf(id)!;
    return (
        renderToStaticMarkup(<AvatarDecorationArt decoration={decoration} />) +
        renderToStaticMarkup(<AvatarDecorationArt decoration={decoration} front />)
    );
}

describe("a decoration on a face", () => {
    it("draws every layer it was given", () => {
        for (const decoration of AVATAR_DECORATIONS) {
            const html = drawn(decoration.id);
            const marks = (html.match(/<(circle|path|ellipse)\b/g) ?? []).length;
            expect([decoration.id, marks >= decoration.layers.length]).toEqual([decoration.id, true]);
        }
    });

    it("moves with a class and a pace, never with SMIL", () => {
        const html = drawn("ember");
        expect(html).toContain("profile-spin");
        expect(html).toContain("profile-twinkle");
        expect(html).toMatch(/animation-duration:\s*12s/);
        expect(html).not.toContain("<animate");
    });

    it("turns the other way when the catalogue says so", () => {
        // Two rings turning the same way read as one drawn twice.
        expect(drawn("circuit")).toContain("animation-direction:reverse");
    });

    it("stands still when nothing in it moves", () => {
        const still = decorationOf("ink")!;
        expect(decorationMoves(still)).toBe(false);
        const html = drawn("ink");
        expect(html).not.toContain("profile-spin");
        expect(html).not.toContain("animation-duration");
    });

    it("gives each face its own gradient, so one is not painted in another's colours", () => {
        const two = renderToStaticMarkup(
            <>
                <AvatarDecorationArt decoration={decorationOf("aurora")!} />
                <AvatarDecorationArt decoration={decorationOf("aurora")!} />
            </>
        );
        const ids = [...two.matchAll(/<linearGradient id="([^"]+)"/g)].map((found) => found[1]);
        expect(ids.length).toBeGreaterThan(1);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("keeps colons out of the ids it then has to point at", () => {
        const html = drawn("aurora");
        for (const [, id] of html.matchAll(/<linearGradient id="([^"]+)"/g)) {
            expect(id).not.toContain(":");
            expect(html).toContain(`url(#${id})`);
        }
    });

    it("says nothing to a screen reader, and takes no presses", () => {
        // It is ornament on a face that already carries the person's name.
        const html = drawn("nova");
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain("pointer-events-none");
    });
});
