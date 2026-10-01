/** Colour arithmetic the screens share. Pure. */

/** Dark or light ink for text drawn on a colour. */
export function inkOn(hex: string): string {
    const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
    if (!match) return "#ffffff";
    const digits = match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join("") : match[1]!;
    const channel = (offset: number) => {
        const value = parseInt(digits.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    return luminance > 0.4 ? "#111318" : "#ffffff";
}
