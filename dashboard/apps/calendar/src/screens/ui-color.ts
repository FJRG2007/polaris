/** Colour arithmetic the screens share. Pure. */

type Rgb = readonly [number, number, number];

/** The dark ink drawn on a light fill: the design's own near-black. */
export const DARK_INK = "#111318";
const LIGHT_INK = "#ffffff";
const BLACK = "#000000";

/** The contrast small text needs (WCAG 2.x, 1.4.3). */
export const TEXT_CONTRAST = 4.5;

/** `#rgb` or `#rrggbb` as channels 0-255; null for anything else. */
export function rgbOf(hex: string): Rgb | null {
    const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
    if (!match) return null;
    const digits =
        match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join("") : match[1]!;
    return [0, 2, 4].map((offset) =>
        parseInt(digits.slice(offset, offset + 2), 16)
    ) as unknown as Rgb;
}

function hexOf(rgb: Rgb): string {
    return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: Rgb): number {
    const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as unknown as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, 1 to 21; 1 when either is unreadable. */
export function contrast(a: string, b: string): number {
    const first = rgbOf(a);
    const second = rgbOf(b);
    if (!first || !second) return 1;
    const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [
        number,
        number
    ];
    return (light + 0.05) / (dark + 0.05);
}

/**
 * The ink for text on one or more fills (a striped fill is two): white or the
 * design's near-black, whichever reads better on the worst of them, and pure
 * black when neither reaches 4.5:1 - which against white always does, since
 * every colour clears 4.5:1 with either white or black.
 */
export function inkFor(...fills: string[]): string {
    const worst = (ink: string) => Math.min(...fills.map((fill) => contrast(ink, fill)));
    const light = worst(LIGHT_INK);
    const dark = worst(DARK_INK);
    if (Math.max(light, dark) >= TEXT_CONTRAST) return light >= dark ? LIGHT_INK : DARK_INK;
    return worst(BLACK) >= light ? BLACK : LIGHT_INK;
}

/** `weight` of `color` over `base`, as a hex colour; `color` when either is unreadable. */
export function mix(color: string, base: string, weight: number): string {
    const top = rgbOf(color);
    const bottom = rgbOf(base);
    if (!top || !bottom) return color;
    return hexOf(
        top.map(
            (channel, index) => channel * weight + bottom[index]! * (1 - weight)
        ) as unknown as Rgb
    );
}

/** A design token's channels ("225 11% 9%") as a hex colour, or null. */
export function hexOfHslChannels(channels: string): string | null {
    const match = /^\s*(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(channels);
    if (!match) return null;
    const hue = ((Number(match[1]) % 360) + 360) % 360;
    const saturation = Number(match[2]) / 100;
    const lightness = Number(match[3]) / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const offset = lightness - chroma / 2;
    const sector = Math.floor(hue / 60);
    const [r, g, b] = (
        [
            [chroma, second, 0],
            [second, chroma, 0],
            [0, chroma, second],
            [0, second, chroma],
            [second, 0, chroma],
            [chroma, 0, second]
        ] as const
    )[sector]!;
    return hexOf([(r + offset) * 255, (g + offset) * 255, (b + offset) * 255]);
}
