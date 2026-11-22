/**
 * The facade runtime (docs/rust-core-plan.md, 3.3): per-domain mode, shadow
 * comparison with hash-only records, and the fallback to TypeScript whenever
 * the Rust binding is missing, fails to load, panics or is too slow.
 *
 * Every facade function is synchronous, like the TypeScript code it replaces.
 * The Node binding loads synchronously on first use; the WebAssembly one loads
 * in the background, and until it is ready every call is answered by
 * TypeScript (a browser never waits on Rust, so first paint cannot either).
 */

import { nativeSource } from "./native";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { BindingMissingError, type CoreBinding, pickBinding } from "./binding";

export { BindingMissingError };
import { DOMAINS, MODES, type DomainName, type Mode } from "./registry";
import { bytesToHex, canonical, encodeValue, outcome, type Expect } from "./vectors";

export type FallbackReason = "missing" | "load-failed" | "panic" | "slow";

export type CoreRecord =
    | { kind: "fallback"; domain: string; op: string; reason: FallbackReason; source: string; at: string }
    | { kind: "difference"; domain: string; op: string; inputHash: string; tsHash: string; rustHash: string; at: string };

export interface BindingSource {
    /** Where the binding comes from, for records: "napi", "wasm", or a test's name. */
    readonly kind: string;
    load(): CoreBinding | Promise<CoreBinding>;
}

type State =
    | { status: "idle" }
    | { status: "loading"; ready: Promise<void> }
    | { status: "ready"; binding: CoreBinding }
    | { status: "failed"; reason: FallbackReason };

/** After this many slow calls in a row a domain stays on TypeScript until restart. */
export const SLOW_CALLS_TO_TRIP = 3;
const RECORD_LIMIT = 200;

let source: BindingSource | null | undefined;
let state: State = { status: "idle" };
let generation = 0;
const overrides = new Map<DomainName, Mode>();
const slowStreak = new Map<DomainName, number>();
const tripped = new Set<DomainName>();
const recent: CoreRecord[] = [];
let sink: ((record: CoreRecord) => void) | null = defaultSink;
// A per-process key: shadow hashes can be compared with each other, but never
// matched against a guessed input (phone numbers are a small space).
const hashKey = globalThis.crypto.getRandomValues(new Uint8Array(32));

function defaultSink(record: CoreRecord) {
    // Server-side only: a fallback is logged, never shown. Browsers keep the
    // bounded in-memory list below and nothing else.
    if (typeof globalThis.process?.versions?.node === "string") console.warn(`[core-rs] ${JSON.stringify(record)}`);
}

function record(entry: CoreRecord) {
    recent.push(entry);
    if (recent.length > RECORD_LIMIT) recent.shift();
    try {
        sink?.(entry);
    } catch {
        // A broken sink must never break the call it is reporting on.
    }
}

function fallback(domain: string, op: string, reason: FallbackReason) {
    record({ kind: "fallback", domain, op, reason, source: currentSource()?.kind ?? "none", at: new Date().toISOString() });
}

function forcedMode(): Mode | undefined {
    const value = globalThis.process?.env?.POLARIS_CORE_RS_FORCE;
    return MODES.includes(value as Mode) ? (value as Mode) : undefined;
}

export function getMode(domain: DomainName): Mode {
    return overrides.get(domain) ?? forcedMode() ?? DOMAINS[domain].mode;
}

/** Set a domain's mode for this instance; `null` returns it to the default. */
export function setMode(domain: DomainName, mode: Mode | null) {
    if (!(domain in DOMAINS)) throw new Error(`core-rs: unknown domain ${domain}`);
    if (mode === null) overrides.delete(domain);
    else if (MODES.includes(mode)) overrides.set(domain, mode);
    else throw new Error(`core-rs: unknown mode ${mode}`);
}

function currentSource(): BindingSource | null {
    if (source === undefined) source = nativeSource();
    return source;
}

/**
 * Replace where the binding comes from (`null`: no binding, TypeScript only)
 * and forget the loaded one. Browsers call this through `useWasm`.
 */
export function setBindingSource(next: BindingSource | null) {
    source = next;
    state = { status: "idle" };
    generation++;
    tripped.clear();
    slowStreak.clear();
}

function classify(error: unknown): FallbackReason {
    return error instanceof BindingMissingError ? "missing" : "load-failed";
}

function loadFailed(reason: FallbackReason, gen: number) {
    if (gen !== generation) return;
    state = { status: "failed", reason };
    fallback("*", "load", reason);
}

function start() {
    const from = currentSource();
    const gen = generation;
    if (!from) {
        loadFailed("missing", gen);
        return;
    }
    let loaded: CoreBinding | Promise<CoreBinding>;
    try {
        loaded = from.load();
    } catch (error) {
        loadFailed(classify(error), gen);
        return;
    }
    if (typeof (loaded as Promise<CoreBinding>)?.then !== "function") {
        try {
            state = { status: "ready", binding: pickBinding(loaded) };
        } catch {
            loadFailed("load-failed", gen);
        }
        return;
    }
    const ready = (loaded as Promise<CoreBinding>).then(
        (binding) => {
            if (gen !== generation) return;
            try {
                state = { status: "ready", binding: pickBinding(binding) };
            } catch {
                loadFailed("load-failed", gen);
            }
        },
        (error: unknown) => loadFailed(classify(error), gen)
    );
    state = { status: "loading", ready };
}

function acquire(): CoreBinding | null {
    if (state.status === "idle") start();
    return state.status === "ready" ? state.binding : null;
}

/**
 * Start loading the binding now and resolve once it is ready or has failed.
 * A screen calls this after it has painted, so the first Rust-backed call does
 * not land before the WebAssembly module has arrived.
 */
export async function ready(): Promise<"ready" | FallbackReason> {
    if (state.status === "idle") start();
    if (state.status === "loading") await state.ready;
    const settled = state as State;
    return settled.status === "ready" ? "ready" : settled.status === "failed" ? settled.reason : "missing";
}

export interface CoreStatus {
    binding: "idle" | "loading" | "ready" | FallbackReason;
    source: string;
    domains: Record<string, { mode: Mode; tripped: boolean }>;
}

export function status(): CoreStatus {
    const domains: CoreStatus["domains"] = {};
    for (const name of Object.keys(DOMAINS) as DomainName[]) domains[name] = { mode: getMode(name), tripped: tripped.has(name) };
    return {
        binding: state.status === "failed" ? state.reason : state.status,
        source: currentSource()?.kind ?? "none",
        domains
    };
}

/** Where records go besides the bounded in-memory list; `null` keeps only the list. */
export function setRecorder(next: ((record: CoreRecord) => void) | null) {
    sink = next;
}

export function records(): CoreRecord[] {
    return recent.slice();
}

export function clearRecords() {
    recent.length = 0;
}

function hash(describe: () => unknown): string {
    let text: string;
    try {
        text = canonical(describe());
    } catch (error) {
        // A value the vector format cannot carry (undefined, a function, NaN)
        // still gets a stable hash rather than breaking the call.
        text = `unencodable:${(error as Error)?.message ?? ""}`;
    }
    return bytesToHex(hmac(sha256, hashKey, new TextEncoder().encode(text))).slice(0, 32);
}

function now(): number {
    return globalThis.performance.now();
}

export interface OpSpec<A extends unknown[], R> {
    domain: DomainName;
    op: string;
    ts: (...args: A) => R;
    rust: (binding: CoreBinding, ...args: A) => R;
    /** Error classes the TypeScript implementation throws, by name; a binding error carrying one of these codes is that error. */
    errors?: Readonly<Record<string, new (message: string) => Error>>;
}

type RustResult<R> = { ok: true; value: R } | { ok: false; error: Error } | { crashed: true };

function runRust<A extends unknown[], R>(spec: OpSpec<A, R>, binding: CoreBinding, args: A): RustResult<R> {
    try {
        return { ok: true, value: spec.rust(binding, ...args) };
    } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const ErrorClass = typeof code === "string" ? spec.errors?.[code] : undefined;
        if (ErrorClass && Object.hasOwn(spec.errors!, code as string)) return { ok: false, error: new ErrorClass((error as Error).message) };
        return { crashed: true };
    }
}

function crash(spec: OpSpec<never, unknown>) {
    // A panic is a stop (plan, section 5): the binding is dropped for the rest
    // of the process, and a trapped WebAssembly instance is unusable anyway.
    state = { status: "failed", reason: "panic" };
    fallback(spec.domain, spec.op, "panic");
}

function settle<R>(result: { ok: true; value: R } | { ok: false; error: Error }): R {
    if (result.ok) return result.value;
    throw result.error;
}

function asExpect<R>(result: { ok: true; value: R } | { ok: false; error: Error }): Expect {
    return outcome(() => settle(result));
}

/** Wrap a TypeScript function and its Rust twin into one facade function with the same signature. */
export function defineOp<A extends unknown[], R>(spec: OpSpec<A, R>): (...args: A) => R {
    const domain = spec.domain;
    const timeoutMs = DOMAINS[domain].timeoutMs;
    return (...args: A): R => {
        const mode = getMode(domain);
        if (mode === "ts" || tripped.has(domain)) return spec.ts(...args);
        const binding = acquire();
        if (!binding) return spec.ts(...args);

        const started = now();
        const rust = runRust(spec, binding, args);
        const elapsed = now() - started;
        if ("crashed" in rust) {
            crash(spec as OpSpec<never, unknown>);
            return spec.ts(...args);
        }
        if (elapsed > timeoutMs) {
            fallback(domain, spec.op, "slow");
            const streak = (slowStreak.get(domain) ?? 0) + 1;
            slowStreak.set(domain, streak);
            if (streak >= SLOW_CALLS_TO_TRIP) tripped.add(domain);
            return spec.ts(...args);
        }
        slowStreak.delete(domain);

        if (mode === "rust") return settle(rust);

        // Shadow: TypeScript answers; the two outcomes are compared by hash.
        let tsResult: { ok: true; value: R } | { ok: false; error: Error };
        try {
            tsResult = { ok: true, value: spec.ts(...args) };
        } catch (error) {
            tsResult = { ok: false, error: error as Error };
        }
        const tsHash = hash(() => asExpect(tsResult));
        const rustHash = hash(() => asExpect(rust));
        if (tsHash !== rustHash)
            record({ kind: "difference", domain, op: spec.op, inputHash: hash(() => encodeValue(args)), tsHash, rustHash, at: new Date().toISOString() });
        return settle(tsResult);
    };
}
