/**
 * Every domain the Rust core serves, with its default mode. This is the one
 * place a mode is set in code (docs/rust-core-plan.md, 3.3); the table lives in
 * `domains.json` so the ledger check (`scripts/ledger-check.mjs`) reads the same
 * data without a TypeScript toolchain.
 *
 * - `mode`: the default for every instance, so an existing install works with no
 *   setup. A module moves ts -> shadow -> rust only through the plan's gates.
 * - `ledger`: the unit in `docs/rust-core-ledger.md` that owns the domain.
 * - `timeoutMs`: a Rust call slower than this is answered by TypeScript instead.
 * - `wasm`: `false` keeps the domain out of the WebAssembly build, so browsers
 *   answer it with TypeScript in every mode and only the Node binding serves it
 *   from Rust. Set when the Rust build would ship more bytes than the
 *   TypeScript it replaces (the ledger row records both sizes).
 */

import table from "./domains.json";

export type Mode = "ts" | "shadow" | "rust";

export const MODES: readonly Mode[] = ["ts", "shadow", "rust"];

export interface DomainConfig {
    readonly mode: Mode;
    readonly ledger: string;
    readonly timeoutMs: number;
    readonly wasm?: boolean;
}

export type DomainName = keyof typeof table;

function checked(raw: Record<string, { mode: string; ledger: string; timeoutMs: number; wasm?: boolean }>) {
    for (const [name, config] of Object.entries(raw)) {
        if (!MODES.includes(config.mode as Mode)) throw new Error(`core-rs: domain ${name} has an unknown mode ${config.mode}`);
        if (!(config.timeoutMs > 0)) throw new Error(`core-rs: domain ${name} needs a positive timeoutMs`);
    }
    return raw as Record<DomainName, DomainConfig>;
}

export const DOMAINS: Readonly<Record<DomainName, DomainConfig>> = checked(table);
