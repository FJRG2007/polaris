/**
 * The Node benchmark (docs/rust-core-plan.md 4.7): the TypeScript twin and the
 * Node binding timed over the same golden vectors that `cargo bench -p
 * polaris-core` replays. One sample is one pass over every case of a vector
 * file, the refused ones included. It reports numbers; whether a domain may
 * serve is decided from them, not here. Product code never imports it.
 */

import { nativeSource } from "./native";
import type { CoreBinding } from "./binding";
import * as twin from "./domains/probe/ts";
import * as phone from "./domains/phone/ts";
import { decodeValue, type VectorFile } from "./vectors";

export interface BenchResult {
    op: string;
    impl: "ts" | "napi";
    samples: number;
    /** Microseconds per pass over the whole vector file. */
    median: number;
    p95: number;
}

type Call = (...args: unknown[]) => unknown;

/** The vector files write `undefined` as `null`; TypeScript gets `undefined` back, the binding takes either. */
const ts =
    (fn: (...args: never[]) => unknown): Call =>
    (...args) =>
        (fn as Call)(...args.map((a) => (a === null ? undefined : a)));

/** `new Intl.Locale(tag).region`, the part of phoneCountryFromLocales the facade keeps in JavaScript. */
function regionOf(tag: unknown): string | null {
    try {
        return new Intl.Locale(tag as string).region ?? null;
    } catch {
        return null;
    }
}

const OPS: Record<string, { ts: Call; napi: (binding: CoreBinding) => Call }> = {
    "probe/fnv1a32": { ts: (text) => twin.fnv1a32(text as string), napi: (b) => (text) => b.probeFnv1a32(text as string) },
    "probe/decodeHex": { ts: (hex) => twin.decodeHex(hex as string), napi: (b) => (hex) => b.probeDecodeHex(hex as string) },
    // The binding side calls the raw exports with the vector's arguments; an
    // argument outside the declared types is refused there, and counted.
    "phone/phoneCountries": { ts: ts(phone.phoneCountries), napi: (b) => () => b.phoneCountries() },
    "phone/isPhoneCountry": { ts: ts(phone.isPhoneCountry), napi: (b) => (code) => b.phoneIsCountry(code as string | null) },
    "phone/phoneCallingCode": { ts: ts(phone.phoneCallingCode), napi: (b) => (country) => b.phoneCallingCode(country as string) },
    "phone/phoneMainCountry": { ts: ts(phone.phoneMainCountry), napi: (b) => (code) => b.phoneMainCountry(code as string) },
    "phone/toE164": { ts: ts(phone.toE164), napi: (b) => (value, country) => b.phoneToE164(value as string, country as string | null) },
    "phone/phoneCountryOf": { ts: ts(phone.phoneCountryOf), napi: (b) => (value) => b.phoneCountryOf(value as string) },
    "phone/splitPhone": { ts: ts(phone.splitPhone), napi: (b) => (value) => b.phoneSplit(value as string) },
    "phone/formatPhoneAsTyped": {
        ts: ts(phone.formatPhoneAsTyped),
        napi: (b) => (value, country) => b.phoneFormatAsTyped(value as string, country as string | null)
    },
    "phone/formatPhoneInternational": { ts: ts(phone.formatPhoneInternational), napi: (b) => (value) => b.phoneFormatInternational(value as string) },
    "phone/phoneCountryFromLocales": {
        ts: ts(phone.phoneCountryFromLocales),
        napi: (b) => (locales) => b.phoneCountryFromRegions((locales as unknown[]).map(regionOf))
    }
};

/** The nearest-rank percentile of sorted samples. */
export function percentile(sorted: number[], p: number): number {
    const value = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    if (value === undefined) throw new Error("no samples");
    return value;
}

function pass(call: Call, cases: unknown[][]): void {
    for (const args of cases) {
        try {
            call(...args);
        } catch {
            // A refused input is part of the workload, as it is in the Rust benchmark.
        }
    }
}

function measure(call: Call, cases: unknown[][], budgetMs: number): number[] {
    const warmEnd = performance.now() + budgetMs / 5;
    while (performance.now() < warmEnd) pass(call, cases);
    const samples: number[] = [];
    const end = performance.now() + budgetMs;
    while (samples.length < 30 || (performance.now() < end && samples.length < 100_000)) {
        const start = performance.now();
        pass(call, cases);
        samples.push((performance.now() - start) * 1000);
    }
    return samples.sort((a, b) => a - b);
}

/**
 * Time every op that has a vector file, on TypeScript and, when `binding` is
 * given, on the Node binding. `budgetMs` is the measuring time per op and impl.
 */
export function bench(files: VectorFile[], binding: CoreBinding | null, budgetMs = 1000): BenchResult[] {
    const results: BenchResult[] = [];
    for (const file of files) {
        const key = `${file.domain}/${file.op}`;
        const op = OPS[key];
        if (!op) throw new Error(`no benchmark for ${key}: add it to OPS in src/bench.ts`);
        const cases = file.cases.map((c) => c.args.map(decodeValue));
        const impls: [BenchResult["impl"], Call][] = [["ts", op.ts]];
        if (binding) impls.push(["napi", op.napi(binding)]);
        for (const [impl, call] of impls) {
            const sorted = measure(call, cases, budgetMs);
            results.push({ op: key, impl, samples: sorted.length, median: percentile(sorted, 50), p95: percentile(sorted, 95) });
        }
    }
    return results;
}

/** The Node binding in `directory` (default: the package's `native/`), or the reason it is not there. */
export function loadNative(directory?: string): { binding: CoreBinding | null; reason?: string } {
    const source = nativeSource(directory);
    if (!source) return { binding: null, reason: "not running in Node" };
    try {
        return { binding: source.load() as CoreBinding };
    } catch (error) {
        return { binding: null, reason: (error as Error).message };
    }
}
