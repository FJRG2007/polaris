/**
 * How a translated picture is painted, kept free of the canvas so it can be
 * tested: the colour that covers each original line (taken from the pixels
 * around it, so a sign on a red wall stays red), the ink that reads on that
 * colour, and the largest font size at which the translation fits the box.
 */

export type Rgb = readonly [number, number, number];

/** A box in pixels: left, top, width, height. */
export type PixelBox = readonly [number, number, number, number];

/** The pixels of a picture, as `ImageData` holds them (RGBA, row by row). */
export interface Pixels {
    data: ArrayLike<number>;
    width: number;
    height: number;
}

/** The most pixels read around one box; a large box is sampled, not read whole. */
const SAMPLE_MAX = 4000;

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The background around `box`: the median of the pixels in a thin ring just
 * outside it (inside it is the text being covered). The median, not the mean,
 * so a stray dark edge or the tail of a neighbouring letter does not muddy it.
 */
export function sampleBackground(pixels: Pixels, box: PixelBox): Rgb {
    const [left, top, width, height] = box;
    const ring = Math.max(2, Math.round(Math.min(width, height) * 0.15));
    const x0 = Math.max(0, Math.floor(left - ring));
    const y0 = Math.max(0, Math.floor(top - ring));
    const x1 = Math.min(pixels.width - 1, Math.ceil(left + width + ring));
    const y1 = Math.min(pixels.height - 1, Math.ceil(top + height + ring));
    const inside = (x: number, y: number) =>
        x >= left && x < left + width && y >= top && y < top + height;
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const step = Math.max(1, Math.floor(Math.sqrt(area / SAMPLE_MAX)));
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    const take = (x: number, y: number) => {
        const at = (y * pixels.width + x) * 4;
        reds.push(pixels.data[at]!);
        greens.push(pixels.data[at + 1]!);
        blues.push(pixels.data[at + 2]!);
    };
    for (let y = y0; y <= y1; y += step) {
        for (let x = x0; x <= x1; x += step) if (!inside(x, y)) take(x, y);
    }
    // A box that fills the picture has no ring: its own pixels are all there is.
    if (reds.length === 0) {
        for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) take(x, y);
    }
    return [median(reds), median(greens), median(blues)];
}

/** Relative luminance (WCAG 2), 0 for black to 1 for white. */
export function luminance([r, g, b]: Rgb): number {
    const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Black or white, whichever has the higher contrast on `background`. */
export function inkFor(background: Rgb): Rgb {
    const light = luminance(background);
    // Contrast with white is 1.05 / (L + 0.05); with black, (L + 0.05) / 0.05.
    return 1.05 / (light + 0.05) > (light + 0.05) / 0.05 ? [255, 255, 255] : [0, 0, 0];
}

export function cssColor([r, g, b]: Rgb): string {
    return `rgb(${r}, ${g}, ${b})`;
}

/** How wide `text` is at `size` pixels. */
export type Measure = (text: string, size: number) => number;

export interface Fitted {
    size: number;
    lines: string[];
}

/** The line height, as a multiple of the font size. */
export const LINE_HEIGHT = 1.15;

/** Breaks `word` into pieces no wider than `width` (a URL, a long compound). */
function breakWord(word: string, width: number, size: number, measure: Measure): string[] {
    const pieces: string[] = [];
    let piece = "";
    for (const char of Array.from(word)) {
        if (piece && measure(piece + char, size) > width) {
            pieces.push(piece);
            piece = char;
        } else piece += char;
    }
    if (piece) pieces.push(piece);
    return pieces;
}

/** `text` wrapped at spaces to lines no wider than `width` at `size`. */
export function wrapText(text: string, width: number, size: number, measure: Measure): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            const candidate = line ? `${line} ${word}` : word;
            if (measure(candidate, size) <= width) {
                line = candidate;
                continue;
            }
            if (line) lines.push(line);
            if (measure(word, size) <= width) line = word;
            else {
                const pieces = breakWord(word, width, size, measure);
                line = pieces.pop() ?? "";
                lines.push(...pieces);
            }
        }
        lines.push(line);
    }
    return lines;
}

/**
 * The largest size from `max` down to `min` at which `text`, wrapped, fits a
 * `width` x `height` box. At `min` it is returned wrapped even if it still
 * overflows: a translation longer than its sign stays readable rather than
 * vanishing.
 */
export function fitText(
    text: string,
    width: number,
    height: number,
    measure: Measure,
    limits: { min: number; max: number }
): Fitted {
    const fits = (size: number) => {
        const lines = wrapText(text, width, size, measure);
        return lines.length * size * LINE_HEIGHT <= height ? lines : null;
    };
    let low = limits.min;
    let high = Math.max(limits.min, limits.max);
    let best: Fitted | null = null;
    while (high - low > 0.5) {
        const size = (low + high) / 2;
        const lines = fits(size);
        if (lines) {
            best = { size, lines };
            low = size;
        } else high = size;
    }
    const top = fits(high);
    if (top) return { size: high, lines: top };
    return best ?? { size: limits.min, lines: wrapText(text, width, limits.min, measure) };
}
