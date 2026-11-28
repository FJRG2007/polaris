/**
 * A print document to ESC/POS bytes.
 *
 * Command bytes are Epson's ESC/POS reference (the TM-T20/T88 command set) as
 * python-escpos and node-escpos also emit them: `ESC @` reset, `ESC t` code page,
 * `ESC E` bold, `ESC -` underline, `GS B` reverse, `GS !` size, `ESC r` second
 * colour, `ESC a` alignment, `GS ( k` QR (model 2, error level M), `GS v 0` raster
 * image, `GS V` feed-and-cut, `ESC p` drawer pulse and `ESC B` buzzer (the
 * compatibles' beeper; an Epson without the optional buzzer ignores it).
 *
 * Text is aligned with spaces rather than `ESC a`, so what is measured here is
 * what prints; only a QR or an image, which have no text width, use `ESC a`.
 */

import * as layout from "./layout.js";
import * as profiles from "./profile.js";
import * as codepage from "./codepage.js";
import type * as doc from "./document.js";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const ALIGN = { left: 0, center: 1, right: 2 } as const;
const SIZE = { normal: 0x00, tall: 0x01, wide: 0x10, large: 0x11 } as const;

type Style = {
    bold?: boolean;
    underline?: boolean;
    invert?: boolean;
    size?: keyof typeof SIZE;
    red?: boolean;
};

function styleOn(style: Style, impact: boolean): number[] {
    const out: number[] = [];
    if (style.bold) out.push(ESC, 0x45, 1);
    if (style.underline) out.push(ESC, 0x2d, 1);
    if (style.invert) out.push(GS, 0x42, 1);
    if (style.size && style.size !== "normal") out.push(GS, 0x21, SIZE[style.size]);
    if (style.red && impact) out.push(ESC, 0x72, 1);
    return out;
}

function styleOff(style: Style, impact: boolean): number[] {
    const out: number[] = [];
    if (style.red && impact) out.push(ESC, 0x72, 0);
    if (style.size && style.size !== "normal") out.push(GS, 0x21, 0);
    if (style.invert) out.push(GS, 0x42, 0);
    if (style.underline) out.push(ESC, 0x2d, 0);
    if (style.bold) out.push(ESC, 0x45, 0);
    return out;
}

/** Columns a line has at this size: double width halves them. */
function widthAt(columns: number, size: Style["size"]): number {
    return size === "wide" || size === "large" ? Math.floor(columns / 2) : columns;
}

function lines(text: string[], page: codepage.Codepage): number[] {
    const out: number[] = [];
    for (const line of text) out.push(...codepage.encodeText(line, page), LF);
    return out;
}

function qr(data: string, size: number): number[] {
    const bytes = Array.from(new TextEncoder().encode(data));
    const length = bytes.length + 3;
    return [
        GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
        GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size,
        GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
        GS, 0x28, 0x6b, length & 0xff, length >> 8, 0x31, 0x50, 0x30, ...bytes,
        GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30
    ];
}

function decodeBits(bits: string): Uint8Array {
    const binary = atob(bits);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
    return out;
}

function image(block: Extract<doc.PrintBlock, { type: "image" }>, maxDots: number): number[] {
    if (block.width > maxDots) throw new RangeError(`image is ${block.width} dots wide, the paper prints ${maxDots}`);
    const bytesWide = block.width / 8;
    const data = decodeBits(block.bits);
    if (data.length !== bytesWide * block.height) {
        throw new RangeError(`image needs ${bytesWide * block.height} bytes of bits, got ${data.length}`);
    }
    return [
        GS, 0x76, 0x30, 0x00,
        bytesWide & 0xff, bytesWide >> 8, block.height & 0xff, block.height >> 8,
        ...data
    ];
}

type TextBlock = Extract<doc.PrintBlock, { type: "text" | "row" | "rule" }>;

function styleOf(block: TextBlock): Style {
    return block.type === "rule" ? {} : block;
}

/** The printed lines of a text block, measured as the printer will print them. */
function blockLines(block: TextBlock, columns: number, page: codepage.Codepage): string[] {
    if (block.type === "rule") return [(block.char ?? "-").repeat(columns)];
    const width = widthAt(columns, block.size);
    if (block.type === "row") return layout.row(codepage.printable(block.left, page), codepage.printable(block.right, page), width);
    return layout
        .wrap(codepage.printable(block.text, page), width)
        .map((line) => layout.align(line, width, block.align ?? "left"));
}

/**
 * The document as the lines of text it prints, for a preview on screen and for
 * tests that read a ticket rather than its bytes. A QR code or a logo shows as a
 * placeholder line; feeds, cuts, the drawer and the buzzer print nothing.
 */
export function previewText(document: doc.PrintDocument, profile: profiles.PrinterProfile): string[] {
    const columns = profiles.columnsOf(profile);
    const out: string[] = [];
    for (const block of document.blocks) {
        if (block.type === "text" || block.type === "row" || block.type === "rule") out.push(...blockLines(block, columns, profile.codepage));
        else if (block.type === "qr") out.push(layout.align("[QR]", columns, "center"));
        else if (block.type === "image") out.push(layout.align("[LOGO]", columns, "center"));
        else if (block.type === "feed") for (let index = 0; index < block.lines; index++) out.push("");
    }
    return out;
}

/**
 * The bytes for a whole document. Starts from `ESC @` so a style left on by an
 * earlier job never bleeds into this one, then selects the profile's code page.
 */
export function encodeEscPos(document: doc.PrintDocument, profile: profiles.PrinterProfile): Uint8Array {
    const columns = profiles.columnsOf(profile);
    const page = profile.codepage;
    const impact = profile.impact === true;
    const out: number[] = [ESC, 0x40, ESC, 0x74, profiles.codepageNumberOf(profile)];
    for (const block of document.blocks) {
        switch (block.type) {
            case "text":
            case "row":
            case "rule":
                out.push(...styleOn(styleOf(block), impact), ...lines(blockLines(block, columns, page), page), ...styleOff(styleOf(block), impact));
                break;
            case "feed":
                out.push(ESC, 0x64, block.lines);
                break;
            case "qr":
                if (impact) {
                    out.push(...lines(layout.wrap(codepage.printable(block.data, page), columns), page));
                    break;
                }
                out.push(ESC, 0x61, ALIGN[block.align ?? "center"], ...qr(block.data, block.size ?? 6), LF, ESC, 0x61, 0);
                break;
            case "image":
                if (impact) break;
                out.push(ESC, 0x61, ALIGN[block.align ?? "center"], ...image(block, profiles.PRINT_DOTS[profile.paper]), ESC, 0x61, 0);
                break;
            case "cut":
                out.push(GS, 0x56, block.partial === false ? 0x41 : 0x42, 3);
                break;
            case "drawer":
                out.push(ESC, 0x70, block.pin === 5 ? 1 : 0, 50, 50);
                break;
            case "beep":
                if (!impact) out.push(ESC, 0x42, block.times ?? 1, 2);
                break;
        }
    }
    return Uint8Array.from(out);
}
