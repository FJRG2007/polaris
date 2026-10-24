// The city's geography in a compact binary form, and back.
//
// The data is a JSON tree whose bulk is long arrays of coordinates. Each array
// made only of numbers leaves the tree and is written as zigzag varints of the
// difference between neighbours, scaled by the fewest decimals that keep every
// value exact (a float64 copy when no scale does). The rest of the tree stays
// JSON, with a marker where each array was. Decoding gives back the same values
// the encoder was handed, so the codec is checked by a round trip.

const MAGIC = 0x47454f31; // "GEO1"
const MARK = "\u0000a";
const RAW = 255;

function decimalsFor(values) {
    for (let places = 0; places <= 6; places++) {
        const scale = 10 ** places;
        let exact = true;
        for (const value of values) {
            const scaled = Math.round(value * scale);
            if (!Number.isSafeInteger(scaled) || Math.abs(scaled) > 2 ** 46 || scaled / scale !== value) {
                exact = false;
                break;
            }
        }
        if (exact) return places;
    }
    return RAW;
}

function isNumberArray(value) {
    return Array.isArray(value) && value.length > 33 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

class Writer {
    constructor() {
        this.bytes = new Uint8Array(1 << 16);
        this.length = 0;
    }
    room(count) {
        if (this.length + count <= this.bytes.length) return;
        const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + count));
        next.set(this.bytes.subarray(0, this.length));
        this.bytes = next;
    }
    varint(value) {
        // Up to 2^53: split rather than shift, which would wrap at 32 bits.
        this.room(8);
        let rest = value;
        while (rest >= 0x80) {
            this.bytes[this.length++] = (rest % 0x80) | 0x80;
            rest = Math.floor(rest / 0x80);
        }
        this.bytes[this.length++] = rest;
    }
    float(value) {
        this.room(8);
        new DataView(this.bytes.buffer).setFloat64(this.length, value, true);
        this.length += 8;
    }
    raw(bytes) {
        this.room(bytes.length);
        this.bytes.set(bytes, this.length);
        this.length += bytes.length;
    }
}

const zig = (value) => (value >= 0 ? value * 2 : -value * 2 - 1);
const unzig = (value) => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);

/** Encode a JSON-safe value into bytes. */
export function encodeGeo(tree) {
    const body = new Writer();
    let count = 0;
    const strip = (value) => {
        if (isNumberArray(value)) {
            const places = decimalsFor(value);
            body.varint(value.length);
            body.varint(places);
            if (places === RAW) for (const item of value) body.float(item);
            else {
                const scale = 10 ** places;
                let previous = 0;
                for (const item of value) {
                    const scaled = Math.round(item * scale);
                    body.varint(zig(scaled - previous));
                    previous = scaled;
                }
            }
            return { [MARK]: count++ };
        }
        if (Array.isArray(value)) return value.map(strip);
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]));
        }
        return value;
    };
    const skeleton = new TextEncoder().encode(JSON.stringify(strip(tree)));
    const out = new Writer();
    out.room(8);
    const head = new DataView(out.bytes.buffer);
    head.setUint32(0, MAGIC, true);
    head.setUint32(4, skeleton.length, true);
    out.length = 8;
    out.raw(skeleton);
    out.raw(body.bytes.subarray(0, body.length));
    return out.bytes.slice(0, out.length);
}

/** Decode bytes written by `encodeGeo`. Throws on anything else. */
export function decodeGeo(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error("Not city data");
    const skeletonLength = view.getUint32(4, true);
    const skeleton = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + skeletonLength)));
    let at = 8 + skeletonLength;
    const varint = () => {
        let value = 0;
        let scale = 1;
        for (;;) {
            if (at >= bytes.byteLength) throw new Error("City data is cut short");
            const byte = bytes[at++];
            value += (byte & 0x7f) * scale;
            if (byte < 0x80) return value;
            scale *= 0x80;
        }
    };
    const arrays = [];
    const readArray = () => {
        const length = varint();
        const places = varint();
        const values = new Array(length);
        if (places === RAW) {
            for (let i = 0; i < length; i++, at += 8) values[i] = view.getFloat64(at, true);
        } else {
            const scale = 10 ** places;
            let previous = 0;
            for (let i = 0; i < length; i++) {
                previous += unzig(varint());
                values[i] = previous / scale;
            }
        }
        return values;
    };
    const fill = (value) => {
        if (Array.isArray(value)) return value.map(fill);
        if (value && typeof value === "object") {
            const keys = Object.keys(value);
            if (keys.length === 1 && keys[0] === MARK) {
                // Arrays are written in the order the encoder walked the tree,
                // which is the order this walk meets them.
                const index = value[MARK];
                while (arrays.length <= index) arrays.push(readArray());
                return arrays[index];
            }
            return Object.fromEntries(keys.map((key) => [key, fill(value[key])]));
        }
        return value;
    };
    return fill(skeleton);
}
