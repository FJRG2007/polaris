/**
 * Facade for the probe domain: the same exports, signatures and errors as
 * `domains/probe/ts.ts`, served by TypeScript or Rust according to the domain's
 * mode. The probe domain proves the facade framework end to end; no product
 * code calls it.
 */

import { defineOp } from "./runtime";
import * as ts from "./domains/probe/ts";

function plainBytes(bytes: Uint8Array): Uint8Array {
    // A binding may hand back a Buffer (a Uint8Array subclass); callers get
    // exactly what the TypeScript implementation returns.
    return Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes);
}

export const fnv1a32: (text: string) => number = defineOp({
    domain: "probe",
    op: "fnv1a32",
    ts: ts.fnv1a32,
    rust: (binding, text) => binding.probeFnv1a32(text)
});

export const decodeHex: (hex: string) => Uint8Array = defineOp({
    domain: "probe",
    op: "decodeHex",
    ts: ts.decodeHex,
    rust: (binding, hex) => plainBytes(binding.probeDecodeHex(hex)),
    errors: { RangeError }
});
