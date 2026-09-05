/**
 * Hex and HSV, both ways.
 *
 * A colour is stored as six hex digits because that is what CSS wants and what a
 * person can be handed, and it is picked in hue, saturation and value because
 * that is the square-and-a-slider everybody has already used. Something has to
 * convert between them on every drag, so it is here: pure, exact at the round
 * trip, and testable without a browser.
 *
 * The one rule worth stating is that a round trip must not drift. A picker holds
 * the colour it is dragging in HSV and writes hex out; if reading that hex back
 * moved the handle, a colour would walk across the square while somebody looked
 * at it. So the conversion rounds once, on the way to hex, and the way back is
 * exact for any hex it produced.
 */

export interface Hsv {
    /** 0-360. */
    readonly hue: number;
    /** 0-100. */
    readonly saturation: number;
    /** 0-100. */
    readonly value: number;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

/** Six hex digits from three channels of 0-255. */
function hex2(value: number): string {
    return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

export function rgbToHex(red: number, green: number, blue: number): string {
    return `#${hex2(red)}${hex2(green)}${hex2(blue)}`;
}

/** The three channels behind a hex colour, or null when it is not one. Accepts
 *  the three-digit shorthand here even though nothing stores it: it is what
 *  somebody types into the box. */
export function hexToRgb(hex: string): { red: number; green: number; blue: number } | null {
    const text = hex.trim().replace(/^#/, "").toLowerCase();
    const full =
        text.length === 3
            ? text
                  .split("")
                  .map((digit) => digit + digit)
                  .join("")
            : text;
    if (!/^[0-9a-f]{6}$/.test(full)) return null;
    return {
        red: Number.parseInt(full.slice(0, 2), 16),
        green: Number.parseInt(full.slice(2, 4), 16),
        blue: Number.parseInt(full.slice(4, 6), 16)
    };
}

export function hexToHsv(hex: string): Hsv | null {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const red = rgb.red / 255;
    const green = rgb.green / 255;
    const blue = rgb.blue / 255;
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const span = high - low;

    let hue = 0;
    if (span !== 0) {
        if (high === red) hue = ((green - blue) / span) % 6;
        else if (high === green) hue = (blue - red) / span + 2;
        else hue = (red - green) / span + 4;
        hue = (hue * 60 + 360) % 360;
    }
    return {
        hue,
        saturation: high === 0 ? 0 : (span / high) * 100,
        value: high * 100
    };
}

export function hsvToHex(hsv: Hsv): string {
    const hue = ((hsv.hue % 360) + 360) % 360;
    const saturation = clamp(hsv.saturation, 0, 100) / 100;
    const value = clamp(hsv.value, 0, 100) / 100;
    const chroma = value * saturation;
    const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const base = value - chroma;

    const [red, green, blue] =
        hue < 60
            ? [chroma, second, 0]
            : hue < 120
              ? [second, chroma, 0]
              : hue < 180
                ? [0, chroma, second]
                : hue < 240
                  ? [0, second, chroma]
                  : hue < 300
                    ? [second, 0, chroma]
                    : [chroma, 0, second];
    return rgbToHex((red + base) * 255, (green + base) * 255, (blue + base) * 255);
}

/**
 * Whether text on this colour should be dark.
 *
 * The usual relative-luminance test, which is what decides whether a swatch's
 * own label can be read against it. Not used to pick the colour of anything
 * somebody typed - a nameplate says outright which it wants, because contrast
 * against a gradient depends on where the letters land on it.
 */
export function prefersDarkText(hex: string): boolean {
    const rgb = hexToRgb(hex);
    if (!rgb) return false;
    const channel = (value: number) => {
        const part = value / 255;
        return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
        0.2126 * channel(rgb.red) + 0.7152 * channel(rgb.green) + 0.0722 * channel(rgb.blue);
    return luminance > 0.45;
}
