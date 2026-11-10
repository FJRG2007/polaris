/**
 * The face a session is drawn with: shapes and colours derived from its id
 * alone, so the same session looks the same everywhere and on every machine.
 */

/** FNV-1a: a stable 32-bit number per string, the same on every machine. */
export function seedOf(text: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** The shapes a session's face is drawn from, derived from its id alone. */
export function avatarShape(id: string) {
    const seed = seedOf(id);
    const hue = seed % 360;
    const bits = (shift: number, mod: number) => (seed >>> shift) % mod;
    return {
        from: `hsl(${hue} 70% 58%)`,
        to: `hsl(${(hue + 40 + bits(9, 120)) % 360} 72% 46%)`,
        blob: `hsl(${(hue + 180) % 360} 80% 70%)`,
        x: 18 + bits(3, 44),
        y: 18 + bits(7, 44),
        r: 14 + bits(13, 14),
        x2: 20 + bits(17, 40),
        y2: 20 + bits(21, 40),
        r2: 8 + bits(25, 12)
    };
}
