/**
 * Golden bytes for the ESC/POS encoder.
 *
 * Every expectation below is written out by hand from Epson's command reference,
 * not captured from the encoder, so a change to a command byte fails here rather
 * than printing garbage on a real roll.
 */

import { describe, expect, it } from "vitest";
import * as print from "../../src/receipt-print/index.js";

const PROFILE_58: print.PrinterProfile = { paper: "58", codepage: "cp858" };
const RESET = [0x1b, 0x40, 0x1b, 0x74, 19];

function encode(blocks: print.PrintBlock[], profile: print.PrinterProfile = PROFILE_58): number[] {
    return Array.from(print.encodeEscPos({ blocks }, profile));
}

function ascii(text: string): number[] {
    return Array.from(text, (char) => char.charCodeAt(0));
}

describe("encodeEscPos", () => {
    it("starts every job from a reset and the profile's code page", () => {
        expect(encode([{ type: "feed", lines: 2 }])).toEqual([...RESET, 0x1b, 0x64, 2]);
        expect(encode([{ type: "feed", lines: 1 }], { paper: "80", codepage: "cp1252" })).toEqual([0x1b, 0x40, 0x1b, 0x74, 16, 0x1b, 0x64, 1]);
        expect(encode([{ type: "feed", lines: 1 }], { paper: "80", codepage: "cp858", codepageNumber: 47 }).slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 47]);
    });

    it("prints Spanish accents and the euro in CP858", () => {
        // CP858: a-acute A0, e-acute 82, n-tilde A4, inverted question A8, euro D5.
        expect(encode([{ type: "text", text: "\u00bfA\u00f1adir caf\u00e9? 3\u20ac" }])).toEqual([
            ...RESET,
            0xa8, ...ascii("A"), 0xa4, ...ascii("adir caf"), 0x82, ...ascii("? 3"), 0xd5, 0x0a
        ]);
    });

    it("prints the euro in WPC1252 and spells it out where the page has none", () => {
        expect(encode([{ type: "text", text: "\u20ac" }], { paper: "58", codepage: "cp1252" }).slice(5)).toEqual([0x80, 0x0a]);
        expect(encode([{ type: "text", text: "3\u20ac" }], { paper: "58", codepage: "cp437" }).slice(5)).toEqual([...ascii("3EUR"), 0x0a]);
    });

    it("bolds, doubles and resets around the line", () => {
        expect(encode([{ type: "text", text: "MESA 4", bold: true, size: "large", align: "center" }])).toEqual([
            ...RESET,
            0x1b, 0x45, 1, 0x1d, 0x21, 0x11,
            // 32 columns at double width is 16; "MESA 4" centred in 16 has 5 spaces before it.
            ...ascii("     MESA 4"), 0x0a,
            0x1d, 0x21, 0, 0x1b, 0x45, 0
        ]);
    });

    it("lays a total out flush right on 32, 42 and 48 columns", () => {
        for (const [paper, columns] of [["58", 32], ["80", 48]] as const) {
            const bytes = encode([{ type: "row", left: "TOTAL", right: "12,50" }], { paper, codepage: "cp858" });
            expect(bytes.slice(5)).toEqual([...ascii(`TOTAL${" ".repeat(columns - 10)}12,50`), 0x0a]);
        }
        const bytes = encode([{ type: "row", left: "TOTAL", right: "12,50" }], { paper: "80", columns: 42, codepage: "cp858" });
        expect(bytes.slice(5)).toEqual([...ascii(`TOTAL${" ".repeat(32)}12,50`), 0x0a]);
    });

    it("draws a rule across the paper", () => {
        expect(encode([{ type: "rule" }]).slice(5)).toEqual([...ascii("-".repeat(32)), 0x0a]);
        expect(encode([{ type: "rule", char: "=" }], { paper: "80", codepage: "cp858" }).slice(5)).toEqual([...ascii("=".repeat(48)), 0x0a]);
    });

    it("encodes a QR code as GS ( k model 2, size, level M, store, print", () => {
        expect(encode([{ type: "qr", data: "AB", size: 4 }]).slice(5)).toEqual([
            0x1b, 0x61, 1,
            0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
            0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 4,
            0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
            0x1d, 0x28, 0x6b, 5, 0, 0x31, 0x50, 0x30, 0x41, 0x42,
            0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
            0x0a, 0x1b, 0x61, 0
        ]);
    });

    it("prints the QR data as text on an impact printer, which has no QR", () => {
        expect(encode([{ type: "qr", data: "AB" }], { paper: "76", codepage: "cp858", impact: true }).slice(5)).toEqual([0x41, 0x42, 0x0a]);
    });

    it("sends a logo as a GS v 0 raster image", () => {
        // 16 x 2 dots: two bytes a row, two rows.
        const bits = btoa(String.fromCharCode(0xff, 0x00, 0x0f, 0xf0));
        expect(encode([{ type: "image", width: 16, height: 2, bits, align: "left" }]).slice(5)).toEqual([
            0x1b, 0x61, 0, 0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0, 0xff, 0x00, 0x0f, 0xf0, 0x1b, 0x61, 0
        ]);
    });

    it("refuses a logo wider than the paper or with the wrong number of bits", () => {
        expect(() => encode([{ type: "image", width: 392, height: 1, bits: btoa("\u0000".repeat(49)) }])).toThrow(RangeError);
        expect(() => encode([{ type: "image", width: 8, height: 2, bits: btoa("\u0000") }])).toThrow(RangeError);
    });

    it("cuts, kicks the drawer and beeps", () => {
        expect(encode([{ type: "cut" }]).slice(5)).toEqual([0x1d, 0x56, 0x42, 3]);
        expect(encode([{ type: "cut", partial: false }]).slice(5)).toEqual([0x1d, 0x56, 0x41, 3]);
        expect(encode([{ type: "drawer" }]).slice(5)).toEqual([0x1b, 0x70, 0, 50, 50]);
        expect(encode([{ type: "drawer", pin: 5 }]).slice(5)).toEqual([0x1b, 0x70, 1, 50, 50]);
        expect(encode([{ type: "beep", times: 3 }]).slice(5)).toEqual([0x1b, 0x42, 3, 2]);
    });

    it("prints red only on an impact printer and never beeps there", () => {
        const impact: print.PrinterProfile = { paper: "76", codepage: "cp858", impact: true };
        expect(encode([{ type: "text", text: "SIN GLUTEN", red: true }], impact).slice(5)).toEqual([
            0x1b, 0x72, 1, ...ascii("SIN GLUTEN"), 0x0a, 0x1b, 0x72, 0
        ]);
        expect(encode([{ type: "text", text: "X", red: true }]).slice(5)).toEqual([0x58, 0x0a]);
        expect(encode([{ type: "beep" }], impact).slice(5)).toEqual([]);
    });
});

describe("layout", () => {
    it("wraps on words and cuts a word longer than the line", () => {
        expect(print.wrap("Tortilla de patatas con cebolla", 12)).toEqual(["Tortilla de", "patatas con", "cebolla"]);
        expect(print.wrap("ABCDEFGHIJ", 4)).toEqual(["ABCD", "EFGH", "IJ"]);
        expect(print.wrap("uno\ndos", 10)).toEqual(["uno", "dos"]);
    });

    it("wraps a long label in the space the amount leaves", () => {
        expect(print.row("2 x Tortilla de patatas con cebolla", "12,50", 20)).toEqual([
            "2 x Tortilla",
            "de patatas con",
            "cebolla        12,50"
        ]);
    });

    it("gives an amount wider than the line a line of its own", () => {
        expect(print.row("A", "1234567890", 10)).toEqual(["A", "1234567890"]);
    });

    it("counts a spelled-out euro as the three columns it prints", () => {
        expect(print.printable("5\u20ac", "cp850")).toBe("5EUR");
        expect(print.printable("5\u20ac", "cp858")).toBe("5\u20ac");
        expect(print.printable("\u0141\u00f3d\u017a", "cp858")).toBe("?\u00f3dz");
    });
});
