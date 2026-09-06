/**
 * The two rows that offer a name style.
 *
 * They are checked by rendering rather than by reading the catalogue, because
 * the way this goes wrong is not a missing entry in a list - it is an entry that
 * is in the list and does not reach the screen. An effect whose properties paint
 * transparent letters on a transparent ground is an option that exists, passes
 * every test of the catalogue, and is invisible to the person choosing.
 *
 * So: one button per effect and one per face, every one of them carrying the
 * word it is named by.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NameEffectPicker, NameFontPicker } from "@/app/(app)/account/name-style-picker";
import { NAME_EFFECTS, NAME_FONTS } from "@polaris/core";

/** With nothing chosen, which is what the picker looks like to somebody who has
 *  never opened it - and the state the colour controls stay out of. */
const effects = renderToStaticMarkup(<NameEffectPicker value={null} onChange={() => {}} />);
const fonts = renderToStaticMarkup(<NameFontPicker value={null} onChange={() => {}} />);

function buttons(html: string): number {
    return (html.match(/<button\b/g) ?? []).length;
}

describe("the display name pickers", () => {
    it("offers every effect there is", () => {
        expect(buttons(effects)).toBe(NAME_EFFECTS.length);
        for (const word of ["None", "Solid", "Gradient", "Neon", "Toon", "Pop", "Gummy", "Prism"]) {
            expect(effects).toContain(`>${word}</span>`);
        }
    });

    it("offers every face there is", () => {
        expect(buttons(fonts)).toBe(NAME_FONTS.length);
        for (const word of ["Default", "Serif", "Handwritten", "Comic", "Script", "Pixel"]) {
            expect(fonts).toContain(`>${word}</span>`);
        }
    });

    it("paints each button as the thing it selects", () => {
        // The word on the button is the answer. A row of eight identical chips
        // reading Solid, Gradient, Neon is a row somebody has to press eight
        // times to find out what it means.
        expect(effects).toContain("text-shadow");
        expect(effects).toContain("background-image");
        for (const face of ["serif", "hand", "comic", "script", "block", "techno", "pixel"]) {
            expect(fonts).toContain(`var(--font-name-${face})`);
        }
    });

    it("keeps the colour controls out of the way when there is no colour", () => {
        // "None" is the letterforms and nothing else, so there is nothing for a
        // colour picker to be the colour of.
        expect(effects.toLowerCase()).not.toContain("colour");
        expect(effects).not.toContain('type="color"');
    });

    it("shows what is already chosen on both rows", () => {
        // The two rows edit one stored value between them, so a look saved from
        // either has to come back marked on both - otherwise choosing a face
        // silently clears the effect the next time the card is opened.
        const saved = "gummy:comic:#ff5a5f:#ffcc66";
        const row = renderToStaticMarkup(<NameEffectPicker value={saved} onChange={() => {}} />);
        const face = renderToStaticMarkup(<NameFontPicker value={saved} onChange={() => {}} />);
        expect(row).toContain('aria-pressed="true"');
        expect(row.match(/aria-pressed="true"/g)).toHaveLength(1);
        expect(face.match(/aria-pressed="true"/g)).toHaveLength(1);
        expect(face).toContain("var(--font-name-comic)");
    });
});
