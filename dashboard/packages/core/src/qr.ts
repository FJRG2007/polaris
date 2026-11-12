/**
 * A QR code for a text: byte mode, error correction level M, the smallest
 * version that fits (1 to 40, up to 2331 bytes) and the mask with the lowest
 * penalty.
 *
 * The same encoder the TV's screensaver carries in Java (`Qr.java`), ported so
 * the desktop app and the browser extension can draw one with no library:
 * ISO/IEC 18004 laid out the way Project Nayuki's MIT-licensed generator does
 * it. Pure, so a code can be checked against a reader in a test.
 */

// Indexed by version; level M.
const ECC_PER_BLOCK = [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28
];
const BLOCKS = [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
    33, 35, 37, 38, 40, 43, 45, 47, 49
];
const FORMAT_M = 0;

export const QR_MAX_VERSION = 40;

function rawDataModules(version: number): number {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const n = Math.floor(version / 7) + 2;
        result -= (25 * n - 10) * n - 55;
        if (version >= 7) result -= 36;
    }
    return result;
}

function dataCodewords(version: number): number {
    return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function mul(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree: number): Uint8Array {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = mul(result[j]!, root);
            if (j + 1 < degree) result[j]! ^= result[j + 1]!;
        }
        root = mul(root, 0x02);
    }
    return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
    const result = new Uint8Array(divisor.length);
    for (const byte of data) {
        const factor = byte ^ result[0]!;
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < result.length; i++) result[i]! ^= mul(divisor[i]!, factor);
    }
    return result;
}

function withEcc(version: number, data: Uint8Array): Uint8Array {
    const blocks = BLOCKS[version]!;
    const eccLen = ECC_PER_BLOCK[version]!;
    const raw = Math.floor(rawDataModules(version) / 8);
    const shortBlocks = blocks - (raw % blocks);
    const shortLen = Math.floor(raw / blocks);
    const divisor = rsDivisor(eccLen);
    const all: Uint8Array[] = [];
    for (let i = 0, k = 0; i < blocks; i++) {
        const datLen = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
        const dat = data.subarray(k, k + datLen);
        k += datLen;
        const block = new Uint8Array(shortLen + 1);
        block.set(dat, 0);
        block.set(rsRemainder(dat, divisor), block.length - eccLen);
        all.push(block);
    }
    const result = new Uint8Array(raw);
    let n = 0;
    for (let i = 0; i < shortLen + 1; i++) {
        for (let j = 0; j < blocks; j++) {
            // Short blocks have a gap where the long ones carry one more data byte.
            if (i !== shortLen - eccLen || j >= shortBlocks) result[n++] = all[j]![i]!;
        }
    }
    return result;
}

function dataBits(bytes: Uint8Array, countBits: number, capacityBits: number): Uint8Array {
    const out = new Uint8Array(capacityBits / 8);
    let length = 0;
    const add = (value: number, count: number) => {
        for (let i = count - 1; i >= 0; i--, length++) {
            if ((value >>> i) & 1) out[length >>> 3]! |= 0x80 >>> (length & 7);
        }
    };
    add(0b0100, 4); // byte mode
    add(bytes.length, countBits);
    for (const byte of bytes) add(byte, 8);
    add(0, Math.min(4, capacityBits - length)); // terminator
    add(0, (8 - (length % 8)) % 8);
    for (let pad = 0xec; length < capacityBits; pad ^= 0xec ^ 0x11) add(pad, 8);
    return out;
}

function alignmentPositions(version: number): number[] {
    if (version === 1) return [];
    const n = Math.floor(version / 7) + 2;
    const step = Math.floor((version * 4 + n * 2 + 1) / (n * 2 - 2)) * 2;
    const result = new Array<number>(n);
    result[0] = 6;
    for (let i = n - 1, pos = version * 4 + 10; i >= 1; i--, pos -= step) result[i] = pos;
    return result;
}

class Grid {
    readonly size: number;
    readonly dark: boolean[][];
    readonly fixed: boolean[][];

    constructor(version: number) {
        this.size = version * 4 + 17;
        this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
        this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    }

    set(x: number, y: number, isDark: boolean): void {
        this.dark[y]![x] = isDark;
        this.fixed[y]![x] = true;
    }

    finder(x: number, y: number): void {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
            }
        }
    }

    format(mask: number): void {
        const data = (FORMAT_M << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        const bit = (i: number) => ((bits >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
        this.set(8, 7, bit(6));
        this.set(8, 8, bit(7));
        this.set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
        this.set(8, this.size - 8, true); // always dark
    }

    functionPatterns(version: number): void {
        for (let i = 0; i < this.size; i++) {
            this.set(6, i, i % 2 === 0);
            this.set(i, 6, i % 2 === 0);
        }
        this.finder(3, 3);
        this.finder(this.size - 4, 3);
        this.finder(3, this.size - 4);
        const align = alignmentPositions(version);
        const n = align.length;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        this.set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                    }
                }
            }
        }
        this.format(0); // reserves the modules; drawn for real once the mask is chosen
        if (version >= 7) {
            let rem = version;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
            const bits = (version << 12) | rem;
            for (let i = 0; i < 18; i++) {
                const isDark = ((bits >>> i) & 1) !== 0;
                const a = this.size - 11 + (i % 3);
                const b = Math.floor(i / 3);
                this.set(a, b, isDark);
                this.set(b, a, isDark);
            }
        }
    }

    codewords(data: Uint8Array): void {
        let i = 0;
        for (let right = this.size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5; // skip the vertical timing column
            for (let vert = 0; vert < this.size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vert : vert;
                    if (!this.fixed[y]![x] && i < data.length * 8) {
                        this.dark[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
                        i++;
                    }
                }
            }
        }
    }

    mask(mask: number): void {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                let invert: boolean;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                    case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                }
                if (invert && !this.fixed[y]![x]) this.dark[y]![x] = !this.dark[y]![x];
            }
        }
    }

    /** The spec's rules 1, 2 and 4: long runs, 2x2 blocks and the dark/light balance. */
    penalty(): number {
        const { size, dark } = this;
        let p = 0;
        for (let a = 0; a < size; a++) {
            let rowRun = 1;
            let colRun = 1;
            for (let b = 1; b < size; b++) {
                if (dark[a]![b] === dark[a]![b - 1]) {
                    if (++rowRun === 5) p += 3;
                    else if (rowRun > 5) p++;
                } else rowRun = 1;
                if (dark[b]![a] === dark[b - 1]![a]) {
                    if (++colRun === 5) p += 3;
                    else if (colRun > 5) p++;
                } else colRun = 1;
            }
        }
        let darkCount = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (dark[y]![x]) darkCount++;
                if (
                    x + 1 < size &&
                    y + 1 < size &&
                    dark[y]![x] === dark[y]![x + 1] &&
                    dark[y]![x] === dark[y + 1]![x] &&
                    dark[y]![x] === dark[y + 1]![x + 1]
                ) {
                    p += 3;
                }
            }
        }
        const total = size * size;
        const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
        return p + Math.max(k, 0) * 10;
    }
}

/** The modules, [y][x], true for dark; null when the text is too long for any version. */
export function encodeQr(text: string): boolean[][] | null {
    const bytes = new TextEncoder().encode(text);
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
        const capacityBits = dataCodewords(version) * 8;
        const countBits = version < 10 ? 8 : 16;
        if (4 + countBits + bytes.length * 8 > capacityBits) continue;
        const grid = new Grid(version);
        grid.functionPatterns(version);
        grid.codewords(withEcc(version, dataBits(bytes, countBits, capacityBits)));
        let best = 0;
        let bestPenalty = Number.POSITIVE_INFINITY;
        for (let mask = 0; mask < 8; mask++) {
            grid.mask(mask);
            grid.format(mask);
            const penalty = grid.penalty();
            if (penalty < bestPenalty) {
                best = mask;
                bestPenalty = penalty;
            }
            grid.mask(mask); // XOR again: undone
        }
        grid.mask(best);
        grid.format(best);
        return grid.dark;
    }
    return null;
}

/** The code as one SVG path, a unit per module, with a four-module quiet zone. */
export function qrSvgPath(modules: readonly (readonly boolean[])[]): { path: string; size: number } {
    const quiet = 4;
    let path = "";
    modules.forEach((row, y) => {
        row.forEach((isDark, x) => {
            if (isDark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        });
    });
    return { path, size: modules.length + quiet * 2 };
}
