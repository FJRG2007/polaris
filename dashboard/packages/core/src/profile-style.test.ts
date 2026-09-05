/**
 * What a profile is allowed to look like.
 *
 * Two things are worth pinning here, and neither is about how anything looks.
 *
 * The first is that nothing reaches a `style` attribute without having been
 * recognised: every id is checked against the catalogue it claims to come from,
 * and a colour that is not six hex digits is not a colour. That is what lets the
 * rendering side interpolate these values into CSS without escaping them, so it
 * has to be true of the reading path as well as the writing one - a row written
 * by an older Polaris goes through the same door.
 *
 * The second is that a stored background survives a round trip exactly. It is
 * one tagged string rather than four columns, which is only a good trade while
 * writing it and reading it back is the identity.
 */

import * as style from "./profile-style.js";
import { describe, expect, it } from "vitest";

describe("a background", () => {
    it("survives being written down and read back", () => {
        for (const fill of [
            { kind: "solid", color: "#1b6ac9" },
            { kind: "gradient", angle: 135, from: "#1b6ac9", to: "#8b3ad6" },
            { kind: "gradient", angle: 0, from: "#000000", to: "#ffffff" }
        ] as const) {
            expect(style.readFill(style.writeFill(fill))).toEqual(fill);
        }
    });

    it("is nothing at all when it is not one", () => {
        for (const stored of [
            null,
            "",
            "solid",
            "solid:blue",
            "solid:#12345",
            "gradient:135:#1b6ac9",
            "url(https://example.test/x.png)",
            "solid:#1b6ac9); background-image: url(x"
        ]) {
            expect(style.readFill(stored)).toBeNull();
        }
    });

    it("wraps an angle rather than refusing it", () => {
        // A picker dragged past a full turn is pointing somewhere real.
        expect(style.readFill("gradient:400:#000000:#ffffff")).toMatchObject({ angle: 40 });
        expect(style.readFill("gradient:-45:#000000:#ffffff")).toMatchObject({ angle: 315 });
    });

    it("reads a colour in either case and stores one spelling", () => {
        expect(style.readFill("solid:#AABBCC")).toEqual({ kind: "solid", color: "#aabbcc" });
    });

    it("draws a flat colour as a gradient of itself", () => {
        // So whatever paints it sets one property, and switching between the two
        // kinds does not switch between two different ones.
        expect(style.fillCss({ kind: "solid", color: "#123456" })).toBe(
            "linear-gradient(#123456, #123456)"
        );
    });
});

describe("a stored row", () => {
    it("keeps the choices Polaris shipped", () => {
        const read = style.readProfileStyle({
            banner: "solid:#1b6ac9",
            decoration: "aurora",
            nameplate: "dusk",
            effect: "gilded",
            nameStyle: "ember"
        });
        expect(read).toEqual({
            banner: { kind: "solid", color: "#1b6ac9" },
            decoration: "aurora",
            nameplate: "dusk",
            effect: "gilded",
            nameStyle: "ember"
        });
    });

    it("drops a choice that is not one of them", () => {
        // An entry withdrawn from a catalogue has to stop being drawn everywhere
        // at once, and a row still naming it must read as nothing rather than as
        // something to guess about.
        expect(
            style.readProfileStyle({
                decoration: "whatever-somebody-typed",
                nameplate: 7,
                effect: null,
                nameStyle: "</style><script>"
            })
        ).toEqual(style.NO_PROFILE_STYLE);
    });

    it("reads an account with no row as an ordinary profile", () => {
        expect(style.readProfileStyle(null)).toEqual(style.NO_PROFILE_STYLE);
        expect(style.readProfileStyle(undefined)).toEqual(style.NO_PROFILE_STYLE);
    });
});

describe("the catalogues", () => {
    it("have no two entries under one id", () => {
        for (const catalogue of [
            style.AVATAR_DECORATIONS,
            style.NAMEPLATES,
            style.PROFILE_EFFECTS,
            style.NAME_STYLES
        ]) {
            expect(new Set(catalogue.map((entry) => entry.id)).size).toBe(catalogue.length);
        }
    });

    it("hold nothing but hex colours", () => {
        // The whole safety argument rests on this: these values are interpolated
        // into CSS, so a stray character in the catalogue itself would be the one
        // way in that no amount of checking the input would catch.
        const colors = [
            ...style.AVATAR_DECORATIONS.flatMap((entry) => style.decorationColors(entry)),
            ...style.NAMEPLATES.flatMap((entry) => [entry.from, entry.to]),
            ...style.PROFILE_EFFECTS.flatMap((entry) => [
                entry.sheen ?? "#000000",
                entry.frame?.from ?? "#000000",
                entry.frame?.to ?? "#000000"
            ]),
            ...style.NAME_STYLES.flatMap((entry) => [...entry.colors])
        ];
        for (const color of colors) expect(style.readHex(color)).toBe(color);
    });
});

describe("a decoration", () => {
    it("stays inside the band the face gives it", () => {
        // The two ways a decoration breaks the product rather than itself: paint
        // outside the box the layout reserved, and it is cut in half by the first
        // scrolling panel it sits in; paint inside the band, and it covers the
        // photograph somebody chose. Both are geometry, so both are checked here
        // rather than looked at.
        for (const decoration of style.AVATAR_DECORATIONS) {
            expect(decoration.layers.length).toBeGreaterThan(0);
            for (const layer of decoration.layers) {
                const reach = style.layerReach(layer);
                expect(reach.outer).toBeLessThanOrEqual(0.5);
                expect(reach.inner).toBeGreaterThanOrEqual(0.5 - decoration.width);
            }
        }
    });

    it("says whether it moves", () => {
        // What the picker prints, so somebody who does not want movement picks
        // without trying each one in turn.
        const still = style.decorationOf("ink");
        const turning = style.decorationOf("rose");
        expect(still && style.decorationMoves(still)).toBe(false);
        expect(turning && style.decorationMoves(turning)).toBe(true);
    });

    it("spaces an orbit from the top and clockwise", () => {
        const [top, right, bottom, left] = style.orbitPoints(4, 0.5);
        expect(top).toEqual({ x: expect.closeTo(0, 6), y: -0.5 });
        expect(right).toEqual({ x: 0.5, y: expect.closeTo(0, 6) });
        expect(bottom).toEqual({ x: expect.closeTo(0, 6), y: 0.5 });
        expect(left).toEqual({ x: -0.5, y: expect.closeTo(0, 6) });
    });

    it("puts a single glyph at the top rather than wherever the arithmetic lands", () => {
        expect(style.orbitPoints(1, 0.46)).toEqual([{ x: expect.closeTo(0, 6), y: -0.46 }]);
    });

    it("has nothing to place for an orbit of nobody", () => {
        expect(style.orbitPoints(0, 0.46)).toEqual([]);
    });

    it("fits a dash pattern to the circle it goes round", () => {
        // Otherwise the last dash meets the first as a stub, and on a ring that
        // turns that seam is carried past the reader over and over.
        const [on, off] = style.fittedDash([0.07, 0.05], 0.45);
        const circumference = 2 * Math.PI * 0.45;
        const repeats = circumference / (on + off);
        expect(repeats).toBeCloseTo(Math.round(repeats), 9);
        // Nudged, not redesigned: the proportions the catalogue asked for hold.
        expect(on / off).toBeCloseTo(0.07 / 0.05, 9);
    });

    it("leaves a pattern alone when there is no circle to fit it to", () => {
        expect(style.fittedDash([0.07, 0.05], 0)).toEqual([0.07, 0.05]);
        expect(style.fittedDash([0, 0], 0.45)).toEqual([0, 0]);
    });
});

describe("a name style", () => {
    it("closes the loop when it moves", () => {
        // A moving name walks one whole tile of its gradient per cycle, so the
        // frame it ends on has to be the frame it started from. If the last
        // colour is not the first, the walk snaps back in front of the reader -
        // several times a minute, in every list its owner appears in.
        for (const entry of style.NAME_STYLES) {
            expect(entry.colors.length).toBeGreaterThanOrEqual(2);
            if (!entry.moving) continue;
            expect(entry.colors.length).toBeGreaterThanOrEqual(3);
            expect(entry.colors.at(-1)).toBe(entry.colors[0]);
        }
    });

    it("offers both kinds", () => {
        expect(style.NAME_STYLES.some((entry) => entry.moving)).toBe(true);
        expect(style.NAME_STYLES.some((entry) => !entry.moving)).toBe(true);
    });
});

describe("a style that says nothing", () => {
    it("is recognised, so it can take its row away rather than store five nulls", () => {
        expect(style.styleIsPlain(style.NO_PROFILE_STYLE)).toBe(true);
        expect(style.styleIsPlain({ ...style.NO_PROFILE_STYLE, decoration: "aurora" })).toBe(false);
    });
});
