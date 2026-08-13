/**
 * The colour the sixteen do not have.
 *
 * Minecraft's modern colour is fourteen characters that draw nothing: a marker, an
 * `x`, and six digits each behind a marker of its own. Every one of those has to be
 * consumed rather than shown - and, less obviously, has to be consumed when the
 * line is measured, because centring counts pixels of drawn glyphs and fourteen
 * stray characters push a line half a screen off.
 *
 * The half-typed case is the one worth being strict about. A sequence that is not
 * complete is not a colour, and reading it as one would eat the characters after it.
 */

import { describe, expect, it } from "vitest";
import { applyMotdHex, hexColorAt, hexMotdCode, motdLineWidth, motdSpans } from "@/lib/apps/minecraft/motd";

const S = "§";
const ORANGE = `${S}x${S}f${S}f${S}8${S}8${S}0${S}0`;

describe("reading a six-digit colour", () => {
    it("draws the text in it, and does not draw the code", () => {
        const [line] = motdSpans(`${ORANGE}Welcome`);
        expect(line).toEqual([
            expect.objectContaining({ text: "Welcome", color: "#ff8800" })
        ]);
    });

    it("measures the line as if the code were not there", () => {
        // Centring is pixels of drawn glyphs. Counted as text, fourteen invisible
        // characters put the line most of a screen off to one side.
        expect(motdLineWidth(`${ORANGE}Welcome`)).toBe(motdLineWidth("Welcome"));
    });

    it("clears the styles the way a named colour does", () => {
        const [line] = motdSpans(`${S}lBold${ORANGE}plain`);
        expect(line?.[1]).toEqual(expect.objectContaining({ text: "plain", color: "#ff8800", bold: false }));
    });

    it("leaves a half-written one as the text it is", () => {
        // Three digits in. Swallowing it would take the rest of the word with it.
        const spans = motdSpans(`${S}x${S}f${S}fHello`);
        expect(spans[0]?.map((span) => span.text).join("")).toContain("Hello");
        expect(hexColorAt(`${S}x${S}f${S}f`, 0)).toBeNull();
    });

    it("refuses digits that are not digits", () => {
        expect(hexColorAt(`${S}x${S}z${S}z${S}z${S}z${S}z${S}z`, 0)).toBeNull();
    });
});

describe("writing one", () => {
    it("spells it the way the game wants it", () => {
        expect(hexMotdCode("#FF8800")).toBe(ORANGE);
        expect(hexMotdCode("ff8800")).toBe(ORANGE);
    });

    it("refuses anything that is not six digits", () => {
        expect(hexMotdCode("#fff")).toBeNull();
        expect(hexMotdCode("orange")).toBeNull();
    });

    it("colours everything from the caret onwards", () => {
        const applied = applyMotdHex("Hello there", 6, "#ff8800");
        expect(applied.text).toBe(`Hello ${ORANGE}there`);
        // Reading it back is the real check: the visible text is unchanged and only
        // the second half is coloured.
        const [line] = motdSpans(applied.text);
        expect(line?.map((span) => span.text).join("")).toBe("Hello there");
        expect(line?.at(-1)?.color).toBe("#ff8800");
    });

    it("changes nothing when the colour is not one", () => {
        expect(applyMotdHex("Hello", 0, "nope").text).toBe("Hello");
    });
});
