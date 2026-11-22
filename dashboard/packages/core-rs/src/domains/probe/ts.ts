/**
 * The probe domain's TypeScript implementation: the twin `polaris-core::probe`
 * must match, and the source of its golden vectors. It exists to prove the
 * whole Rust core chain before a real domain moves; nothing in the product
 * calls it.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-8 encoding of `text` (unpaired surrogates encode as U+FFFD). */
export function fnv1a32(text: string): number {
    let hash = FNV_OFFSET;
    for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
    return hash >>> 0;
}

function hexValue(unit: number): number {
    if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
    if (unit >= 0x41 && unit <= 0x46) return unit - 0x41 + 10;
    if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10;
    return -1;
}

/** Decode a hex string (either case, no prefix, no separators) into bytes. */
export function decodeHex(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new RangeError("Invalid hex string: odd length");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        const high = hexValue(hex.charCodeAt(i));
        if (high < 0) throw new RangeError(`Invalid hex string at index ${i}`);
        const low = hexValue(hex.charCodeAt(i + 1));
        if (low < 0) throw new RangeError(`Invalid hex string at index ${i + 1}`);
        out[i / 2] = (high << 4) | low;
    }
    return out;
}
