/**
 * Answers worked out on the computer as they are typed: arithmetic
 * (`2^10 / 4`, `sqrt(2) * pi`, `539€ + 21%`) and unit conversions (`5 km to mi`,
 * `100 f in c`, `3 gib to mb`). The arithmetic is `@polaris/core`'s calculator,
 * the one the dashboard's search panel uses, never `eval`: what is typed into
 * the launcher is text, not code.
 */

import { calculate, calculation, calculationText, formatCalculation } from "@polaris/core/calculate";

export interface QuickAnswer {
    /** The answer as it is shown and copied. */
    readonly value: string;
    /** What it was worked out from, e.g. "5 km in mi". */
    readonly label: string;
    /** What Enter copies when it is not `value`: plain digits for an amount of
     *  money shown with its sign, "652.19" for "€652.19". */
    readonly copy?: string;
}

/** The value of an arithmetic expression, or null when it is not one. The
 *  dashboard's search panel works sums out with the same parser. */
export function evaluate(text: string): number | null {
    return calculate(text);
}

/** Each unit as a factor of its family's base, or a pair of functions for temperature. */
interface Unit {
    readonly family: string;
    readonly toBase: (x: number) => number;
    readonly fromBase: (x: number) => number;
}

const linear = (family: string, factor: number): Unit => ({ family, toBase: (x) => x * factor, fromBase: (x) => x / factor });

const UNITS: Readonly<Record<string, Unit>> = {
    mm: linear("length", 0.001),
    cm: linear("length", 0.01),
    m: linear("length", 1),
    km: linear("length", 1000),
    in: linear("length", 0.0254),
    ft: linear("length", 0.3048),
    yd: linear("length", 0.9144),
    mi: linear("length", 1609.344),
    mg: linear("mass", 0.001),
    g: linear("mass", 1),
    kg: linear("mass", 1000),
    oz: linear("mass", 28.349523125),
    lb: linear("mass", 453.59237),
    ml: linear("volume", 0.001),
    l: linear("volume", 1),
    gal: linear("volume", 3.785411784),
    ms: linear("time", 0.001),
    s: linear("time", 1),
    min: linear("time", 60),
    h: linear("time", 3600),
    d: linear("time", 86400),
    b: linear("data", 1),
    kb: linear("data", 1e3),
    mb: linear("data", 1e6),
    gb: linear("data", 1e9),
    tb: linear("data", 1e12),
    kib: linear("data", 1024),
    mib: linear("data", 1024 ** 2),
    gib: linear("data", 1024 ** 3),
    tib: linear("data", 1024 ** 4),
    c: { family: "temperature", toBase: (x) => x, fromBase: (x) => x },
    f: { family: "temperature", toBase: (x) => ((x - 32) * 5) / 9, fromBase: (x) => (x * 9) / 5 + 32 },
    k: { family: "temperature", toBase: (x) => x - 273.15, fromBase: (x) => x + 273.15 }
};

/** A number shown to at most ten significant digits, without trailing zeros. */
export function formatNumber(value: number): string {
    if (Object.is(value, -0)) return "0";
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return value.toExponential(6).replace(/\.?0+e/, "e");
    return String(Number(value.toPrecision(10)));
}

/** `5 km to mi`, `100f in c`: the converted value, or null. */
export function convert(text: string): QuickAnswer | null {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:to|in)\s+([a-z]+)\s*$/i.exec(text);
    if (!match) return null;
    const amount = Number(match[1]);
    const fromName = match[2]!.toLowerCase();
    const toName = match[3]!.toLowerCase();
    const from = UNITS[fromName];
    const to = UNITS[toName];
    if (!from || !to || from.family !== to.family) return null;
    const value = to.fromBase(from.toBase(amount));
    return { value: formatNumber(value), label: `${formatNumber(amount)} ${fromName} in ${toName}` };
}

/** The quick answer to what was typed, or null. A bare number or word is not a question. */
export function quickAnswer(text: string): QuickAnswer | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 300) return null;
    const conversion = convert(trimmed);
    if (conversion) return conversion;
    const result = calculation(trimmed);
    if (result === null) return null;
    if (result.currency === null) return { value: formatNumber(result.value), label: trimmed };
    return { value: formatCalculation(result), label: trimmed, copy: calculationText(result.value, result.currency) };
}
