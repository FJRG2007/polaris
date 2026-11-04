/**
 * A translated picture: each line covered with the colour around it, the ink
 * that reads on it, and the translation fitted to the line's box.
 */

import { describe, expect, it } from "vitest";
import { isRightToLeft } from "@polaris-app/translate/src/model/languages";
import {
    fitText,
    inkFor,
    sampleBackground,
    wrapText,
    LINE_HEIGHT,
    type Pixels
} from "@polaris-app/translate/src/model/overlay";

/** A picture filled with `outside`, with a `inside` rectangle painted at `box`. */
function picture(
    width: number,
    height: number,
    outside: [number, number, number],
    inside: [number, number, number],
    box: [number, number, number, number]
): Pixels {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const within = x >= box[0] && x < box[0] + box[2] && y >= box[1] && y < box[1] + box[3];
            const [r, g, b] = within ? inside : outside;
            data.set([r, g, b, 255], (y * width + x) * 4);
        }
    }
    return { data, width, height };
}

/** Every character is `size * 0.5` wide. */
const measure = (text: string, size: number) => Array.from(text).length * size * 0.5;

describe("sampleBackground", () => {
    it("takes the colour around the text, not the text", () => {
        const pixels = picture(100, 60, [200, 30, 40], [255, 255, 255], [20, 20, 60, 20]);
        expect(sampleBackground(pixels, [20, 20, 60, 20])).toEqual([200, 30, 40]);
    });

    it("ignores a stray dark edge (median, not mean)", () => {
        const pixels = picture(100, 60, [10, 120, 10], [0, 0, 0], [20, 20, 60, 20]);
        // A dark stripe touching the box on one side.
        const data = pixels.data as Uint8ClampedArray;
        for (let y = 0; y < 60; y++) data.set([0, 0, 0, 255], (y * 100 + 19) * 4);
        expect(sampleBackground(pixels, [20, 20, 60, 20])).toEqual([10, 120, 10]);
    });

    it("clamps a box at the picture's edge and one that fills it", () => {
        const pixels = picture(40, 40, [50, 60, 70], [50, 60, 70], [0, 0, 40, 40]);
        expect(sampleBackground(pixels, [0, 0, 40, 40])).toEqual([50, 60, 70]);
        expect(sampleBackground(pixels, [-5, -5, 20, 20])).toEqual([50, 60, 70]);
    });

    it("samples a large picture without reading every pixel", () => {
        const pixels = picture(2000, 1500, [90, 90, 90], [0, 0, 0], [100, 100, 1800, 1300]);
        expect(sampleBackground(pixels, [100, 100, 1800, 1300])).toEqual([90, 90, 90]);
    });
});

describe("inkFor", () => {
    it("writes black on light and white on dark", () => {
        expect(inkFor([255, 255, 200])).toEqual([0, 0, 0]);
        expect(inkFor([20, 20, 60])).toEqual([255, 255, 255]);
        expect(inkFor([200, 30, 40])).toEqual([255, 255, 255]);
    });
});

describe("fitText", () => {
    it("keeps a short text at the largest size", () => {
        const fitted = fitText("Exit", 200, 40, measure, { min: 8, max: 30 });
        expect(fitted.size).toBe(30);
        expect(fitted.lines).toEqual(["Exit"]);
    });

    it("shrinks a long text until it fits the box, wrapping at spaces", () => {
        const text = "Please keep the door closed at all times";
        const fitted = fitText(text, 100, 40, measure, { min: 6, max: 30 });
        expect(fitted.size).toBeLessThan(30);
        expect(fitted.lines.length * fitted.size * LINE_HEIGHT).toBeLessThanOrEqual(40);
        for (const line of fitted.lines)
            expect(measure(line, fitted.size)).toBeLessThanOrEqual(100);
        expect(fitted.lines.join(" ")).toBe(text);
    });

    it("stops at the smallest size and still wraps when nothing fits", () => {
        const fitted = fitText("word ".repeat(80).trim(), 50, 10, measure, { min: 8, max: 20 });
        expect(fitted.size).toBe(8);
        expect(fitted.lines.length).toBeGreaterThan(1);
    });

    it("breaks a word longer than the box", () => {
        const lines = wrapText("https://example.test/a/very/long/path", 40, 10, measure);
        expect(lines.join("")).toBe("https://example.test/a/very/long/path");
        for (const line of lines) expect(measure(line, 10)).toBeLessThanOrEqual(40);
    });

    it("keeps the text's own line breaks and right-to-left text whole", () => {
        expect(wrapText("one\ntwo", 500, 10, measure)).toEqual(["one", "two"]);
        const hebrew = "שלום עולם";
        expect(fitText(hebrew, 500, 40, measure, { min: 8, max: 20 }).lines).toEqual([hebrew]);
    });
});

describe("isRightToLeft", () => {
    it("knows the right-to-left languages by their primary subtag", () => {
        expect(isRightToLeft("ar")).toBe(true);
        expect(isRightToLeft("he-IL")).toBe(true);
        expect(isRightToLeft("en")).toBe(false);
        expect(isRightToLeft(null)).toBe(false);
    });
});
