/**
 * Text to bytes for a receipt printer.
 *
 * An ESC/POS printer has no Unicode: it prints one byte per character from the
 * code page selected with `ESC t n`. The page numbers are Epson's (ESC/POS
 * Application Programming Guide, "ESC t"), which Bixolon, Xprinter and Star's
 * ESC/POS emulation follow for these four; a printer that numbers them otherwise
 * takes an override on its profile (`codepageNumber`).
 *
 * Spanish needs accents, the n with a tilde, the inverted marks and the euro. PC858
 * and WPC1252 carry all of them; PC850 and PC437 carry everything but the euro,
 * which is spelled "EUR" there rather than printed as a question mark.
 */

import * as tables from "./codepage-tables.js";

export type Codepage = "cp858" | "cp1252" | "cp850" | "cp437";

export const CODEPAGES: readonly Codepage[] = ["cp858", "cp1252", "cp850", "cp437"];

/** Epson's `ESC t` number for each page. */
export const ESC_T_NUMBER: Readonly<Record<Codepage, number>> = {
    cp437: 0,
    cp850: 2,
    cp1252: 16,
    cp858: 19
};

const HIGH: Readonly<Record<Codepage, string>> = {
    cp437: tables.CP437_HIGH,
    cp850: tables.CP850_HIGH,
    cp858: tables.CP858_HIGH,
    cp1252: tables.CP1252_HIGH
};

const REVERSE = new Map<Codepage, Map<string, number>>();

function reverse(page: Codepage): Map<string, number> {
    let map = REVERSE.get(page);
    if (map) return map;
    map = new Map();
    const high = HIGH[page];
    for (let index = 0; index < high.length; index++) {
        const char = high[index]!;
        if (char !== "\u0000" && !map.has(char)) map.set(char, 0x80 + index);
    }
    REVERSE.set(page, map);
    return map;
}

/** Characters a page may lack, spelled with ones every page has. */
const SPELLED: Readonly<Record<string, string>> = {
    "\u20ac": "EUR",
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": "\"",
    "\u201d": "\"",
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "\u00a0": " ",
    "\u202f": " ",
    "\u2022": "*"
};

/**
 * The string as the printer will see it, one character per printed column: what
 * the page has is kept, what it lacks is spelled out or stripped of its accent,
 * and what is left after that becomes "?". Layout measures this, not the input,
 * so a "EUR" that replaced one character is counted as three.
 */
export function printable(text: string, page: Codepage): string {
    const map = reverse(page);
    let out = "";
    for (const char of text.normalize("NFC")) {
        const code = char.codePointAt(0)!;
        if (code === 0x0a || (code >= 0x20 && code < 0x7f) || map.has(char)) {
            out += char;
            continue;
        }
        if (code < 0x20 || code === 0x7f) continue;
        const spelled = SPELLED[char];
        if (spelled !== undefined) {
            out += spelled;
            continue;
        }
        const bare = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        out += bare.length > 0 && [...bare].every((part) => part.charCodeAt(0) < 0x7f || map.has(part)) ? bare : "?";
    }
    return out;
}

/** Bytes of a string already passed through `printable`. */
export function encodeText(text: string, page: Codepage): number[] {
    const map = reverse(page);
    const bytes: number[] = [];
    for (const char of printable(text, page)) {
        const code = char.charCodeAt(0);
        bytes.push(code < 0x80 ? code : (map.get(char) ?? 0x3f));
    }
    return bytes;
}
