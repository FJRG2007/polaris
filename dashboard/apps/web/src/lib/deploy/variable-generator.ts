/**
 * A variable's generator: `${{ secret() }}`, `${{ secret(32) }}` or
 * `${{ secret(8, "abc") }}`, the way Railway's template functions are written.
 *
 * Typed as a value, the generator is kept beside the variable and a fresh value
 * is drawn from it there and then, and again for every environment made from
 * this one - so a preview or a copied environment gets a password of its own
 * instead of the original's.
 *
 * Pure and client-safe: the dialog previews with the same code the server
 * stores with. Characters are drawn with `crypto.getRandomValues` (the Web
 * Crypto CSPRNG, the same source as Node's `randomBytes`) by rejection
 * sampling, so every character of the alphabet is equally likely - a plain
 * `byte % size` would favour the first `256 % size` of them.
 */

import { z } from "zod";

/** Letters and digits: safe in a URL, a shell and a connection string. */
export const DEFAULT_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const DEFAULT_LENGTH = 32;
export const MAX_LENGTH = 256;

export interface GeneratorSpec {
    readonly length: number;
    readonly alphabet: string;
}

/** `${{ secret() }}`, `${{ secret(N) }}` or `${{ secret(N, "chars") }}`, spaces optional. */
const EXPRESSION =
    /^\$\{\{\s*secret\(\s*(?:(\d{1,4})\s*(?:,\s*"([^"\\]*)"\s*)?)?\)\s*\}\}$/;

export const generatorSpecSchema = z.object({
    length: z.number().int().min(1).max(MAX_LENGTH),
    alphabet: z
        .string()
        .min(2)
        .max(256)
        // Printable, one line, no quote or backslash: it is written back inside quotes.
        .regex(/^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/)
        .refine((chars) => new Set(chars).size === chars.length)
});

/** The spec a value written as a generator asks for, or null when it is not one. */
export function parseGenerator(value: string): GeneratorSpec | null {
    const match = EXPRESSION.exec(value.trim());
    if (!match) return null;
    const spec = {
        length: match[1] === undefined ? DEFAULT_LENGTH : Number(match[1]),
        alphabet: match[2] === undefined ? DEFAULT_ALPHABET : match[2]
    };
    return generatorSpecSchema.safeParse(spec).success ? spec : null;
}

/** True when the value looks like a generator but asks for something out of range. */
export function isBrokenGenerator(value: string): boolean {
    return /^\$\{\{\s*secret\(/.test(value.trim()) && parseGenerator(value) === null;
}

/** The spec written the shortest way that reads back as itself. */
export function formatGenerator(spec: GeneratorSpec): string {
    if (spec.alphabet === DEFAULT_ALPHABET) {
        return spec.length === DEFAULT_LENGTH ? "${{ secret() }}" : `\${{ secret(${spec.length}) }}`;
    }
    return `\${{ secret(${spec.length}, "${spec.alphabet}") }}`;
}

type RandomFill = (bytes: Uint8Array) => Uint8Array;

const webRandom: RandomFill = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** A fresh value for the spec. `fill` is only swapped by tests. */
export function generateValue(spec: GeneratorSpec, fill: RandomFill = webRandom): string {
    const size = spec.alphabet.length;
    // The largest multiple of `size` a byte reaches: a byte at or past it is
    // thrown away rather than folded onto the start of the alphabet.
    const limit = 256 - (256 % size);
    let out = "";
    while (out.length < spec.length) {
        const bytes = fill(new Uint8Array(Math.max(16, (spec.length - out.length) * 2)));
        for (const byte of bytes) {
            if (byte >= limit) continue;
            out += spec.alphabet[byte % size];
            if (out.length === spec.length) break;
        }
    }
    return out;
}
