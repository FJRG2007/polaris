/**
 * Telling one mailbox from another.
 *
 * A mailbox gets a colour so that a row in a merged list says which mailbox it
 * came from without being read. It was a hash of the address into eight
 * swatches, which is right about the thing that matters - a mailbox keeps its
 * colour when another is added above it - and wrong about the thing the colour
 * is for: two addresses collide about one time in eight, and somebody who adds
 * two mailboxes and gets two identical dots has a rail that tells them nothing.
 *
 * Asserted as properties rather than as fixed colours, because which swatch any
 * one address lands on is not a promise to anybody.
 */

import { describe, expect, it } from "vitest";
import { MAIL_PALETTE, coloursFor } from "@/app/(app)/mail/palette";

/** A mailbox as this only needs to know it. */
function box(address: string, color: string | null = null) {
    return { id: address, address, color };
}

/** Addresses enough to be sure a collision is in there: eight swatches, so any
 *  nine distinct addresses must contain two that hash together. */
const MANY = Array.from({ length: 8 }, (_, index) => box(`person${index}@example.com`));

describe("a colour per mailbox", () => {
    it("gives no two the same one", () => {
        const colours = coloursFor(MANY);
        const given = Object.values(colours);
        expect(new Set(given).size).toBe(given.length);
    });

    it("gives every one of them a colour from the palette", () => {
        const palette = new Set(MAIL_PALETTE.map((swatch) => swatch.hex));
        for (const colour of Object.values(coloursFor(MANY))) {
            expect(palette.has(colour), colour).toBe(true);
        }
    });

    it("keeps the one somebody chose, and works around it", () => {
        const chosen = MAIL_PALETTE[3]!.hex;
        const colours = coloursFor([box("a@example.com", chosen), box("b@example.com")]);
        expect(colours["a@example.com"]).toBe(chosen);
        expect(colours["b@example.com"]).not.toBe(chosen);
    });

    it("does not move a mailbox because another was added", () => {
        // A rail whose colours shuffle on every change is a rail nobody learns.
        const first = coloursFor([box("a@example.com"), box("b@example.com")]);
        const after = coloursFor([box("a@example.com"), box("b@example.com"), box("c@example.com")]);
        expect(after["a@example.com"]).toBe(first["a@example.com"]);
        expect(after["b@example.com"]).toBe(first["b@example.com"]);
    });

    it("is the same answer however often it is asked", () => {
        expect(coloursFor(MANY)).toEqual(coloursFor(MANY));
    });

    it("still answers past the end of the palette", () => {
        // Nine mailboxes and eight colours: two share, and every one of them
        // still has a colour rather than none.
        const nine = [...MANY, box("ninth@example.com")];
        const colours = coloursFor(nine);
        expect(Object.keys(colours)).toHaveLength(nine.length);
        for (const colour of Object.values(colours)) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    });
});
