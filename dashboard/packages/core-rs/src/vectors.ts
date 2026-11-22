/**
 * The golden-vector format (crates/polaris-core-vectors/README.md) on the
 * TypeScript side: decode a case's arguments, encode an outcome the same way the
 * generator did, and replay a file against any implementation. The generator,
 * the Node and WebAssembly parity runs and the headless-browser run all use
 * this one codec, and the facade hashes shadow outcomes with it.
 */

export type Expect = { ok: unknown } | { error: { kind: string; message: string } };

export interface VectorCase {
    name: string;
    args: unknown[];
    expect: Expect;
}

export interface VectorFile {
    domain: string;
    op: string;
    source: string;
    cases: VectorCase[];
}

/** Largest `$repeat` expansion, matching the Rust loader's MAX_REPEAT_BYTES. */
export const MAX_REPEAT_BYTES = 64 * 1024 * 1024;

const HEX = /^(?:[0-9a-f]{2})*$/;

function isWellFormed(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) i++;
            else return false;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
}

export function bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    if (!HEX.test(hex)) throw new Error("$bytes must be lowercase hex with an even number of digits");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Expand the tagged values of the vector format into real JavaScript values. */
export function decodeValue(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(decodeValue);
    const entries = Object.entries(value);
    const tag = entries.find(([key]) => key.startsWith("$"));
    if (!tag) return Object.fromEntries(entries.map(([k, v]) => [k, decodeValue(v)]));
    if (entries.length !== 1) throw new Error(`${tag[0]} must be the only key of its object`);
    const [name, body] = tag;
    if (name === "$bytes" && typeof body === "string") return hexToBytes(body);
    if (name === "$utf16" && Array.isArray(body)) {
        if (!body.every((u) => Number.isInteger(u) && u >= 0 && u <= 0xffff)) throw new Error("$utf16 holds code units 0..=65535");
        let out = "";
        for (const unit of body as number[]) out += String.fromCharCode(unit);
        return out;
    }
    if (name === "$repeat" && body && typeof body === "object" && !Array.isArray(body)) {
        const spec = body as Record<string, unknown>;
        const { text, times } = spec;
        if (Object.keys(spec).length !== 2 || typeof text !== "string" || !Number.isInteger(times) || (times as number) < 0)
            throw new Error("$repeat takes exactly text and times");
        if (new TextEncoder().encode(text).length * (times as number) > MAX_REPEAT_BYTES) throw new Error("$repeat expands past MAX_REPEAT_BYTES");
        return text.repeat(times as number);
    }
    throw new Error(`unknown or malformed tag ${name}`);
}

/** Encode a JavaScript value into the vector format (the inverse of decodeValue, without $repeat). */
export function encodeValue(value: unknown): unknown {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`cannot encode ${value}`);
        return value;
    }
    if (typeof value === "string") {
        if (isWellFormed(value)) return value;
        const units: number[] = [];
        for (let i = 0; i < value.length; i++) units.push(value.charCodeAt(i));
        return { $utf16: units };
    }
    if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
    if (Array.isArray(value)) return value.map(encodeValue);
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) out[key] = encodeValue((value as Record<string, unknown>)[key]);
        return out;
    }
    throw new Error(`cannot encode a ${typeof value}`);
}

/** Run `fn` and describe what happened in the vector format. */
export function outcome(fn: () => unknown): Expect {
    let result: unknown;
    try {
        result = fn();
    } catch (error) {
        const e = error as Error;
        return { error: { kind: e?.name ?? typeof error, message: e?.message ?? String(error) } };
    }
    return { ok: encodeValue(result) };
}

/** JSON with object keys sorted, so two equal outcomes always serialize alike. */
export function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
            : v
    );
}

export interface Mismatch {
    case: string;
    expected: string;
    actual: string;
}

/** Replay every case of `file` through `call`; an empty result means full parity. */
export function replay(file: VectorFile, call: (...args: unknown[]) => unknown): Mismatch[] {
    const mismatches: Mismatch[] = [];
    for (const vector of file.cases) {
        const args = vector.args.map(decodeValue);
        const expected = canonical(vector.expect);
        const actual = canonical(outcome(() => call(...args)));
        if (expected !== actual) mismatches.push({ case: vector.name, expected: expected.slice(0, 300), actual: actual.slice(0, 300) });
    }
    return mismatches;
}
