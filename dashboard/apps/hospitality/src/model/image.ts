/**
 * Menu pictures: what a stored picture is, from its first bytes (never from
 * what the request says), and the square the crop dialog cuts them to.
 */

/** Square, rounded corners, 512 px wide, re-encoded to WebP by the crop dialog. */
export const MENU_PICTURE_CROP = { ratio: 1, round: false, maxWidth: 512 } as const;

export function sniffImage(bytes: Uint8Array): "image/webp" | "image/png" | "image/jpeg" | null {
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
    if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    return null;
}
