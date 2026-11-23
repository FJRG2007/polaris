/**
 * The packaging check (docs/rust-core-plan.md, F6): load the binding an artifact
 * ships, through the facade, and prove it answers like TypeScript. Each build
 * runs it on the exact files it packages - the image's `.node`, Electron's
 * unpacked one, the extension's and the web bundle's `.wasm` - so a binding
 * that is missing, stale or for the wrong platform fails the build instead of
 * quietly leaving every call on TypeScript. Product code never imports it.
 */

import * as probe from "./probe";
import { nativeSource } from "./native";
import { canonical, outcome } from "./vectors";
import { loadWasmBinding, useWasm } from "./wasm";
import { clearRecords, ready, records, setBindingSource, setMode, setRecorder, status } from "./runtime";

export type SmokeTarget =
    /** The Node binding in `directory` (default: the package's own `native/`). */
    | { kind: "napi"; directory?: string }
    /** The WebAssembly binding: the glue module's URL and the `.wasm` (URL, Response or bytes). */
    | { kind: "wasm"; glueUrl: string; wasm: unknown };

export interface SmokeReport {
    /** `ready`, or why the binding is not serving (`missing` when there is no file for this platform). */
    binding: string;
    source: string;
    /** Inputs answered by Rust and compared with TypeScript. */
    checked: number;
    problems: string[];
}

/** Inputs for every probe op, the error path and unpaired surrogates included. */
const CORPUS: { op: string; call: (input: string) => unknown; inputs: string[] }[] = [
    { op: "fnv1a32", call: (t) => probe.fnv1a32(t), inputs: ["", "a", "polaris", "é\u{1F600}", "\ud800", "x".repeat(4096)] },
    { op: "decodeHex", call: (h) => probe.decodeHex(h), inputs: ["", "00", "ff10", "0", "zz", "ABCD"] }
];

export async function smoke(target: SmokeTarget): Promise<SmokeReport> {
    if (target.kind === "napi") setBindingSource(nativeSource(target.directory));
    else useWasm(() => loadWasmBinding(target.glueUrl, target.wasm));
    setRecorder(null);
    clearRecords();
    const binding = await ready();
    const problems: string[] = [];
    let checked = 0;
    if (binding === "ready") {
        for (const { op, call, inputs } of CORPUS)
            inputs.forEach((input, index) => {
                setMode("probe", "ts");
                const ts = canonical(outcome(() => call(input)));
                setMode("probe", "rust");
                const rust = canonical(outcome(() => call(input)));
                if (ts !== rust) problems.push(`probe.${op} input #${index}: Rust answered ${rust}, TypeScript ${ts}`);
                checked++;
            });
        setMode("probe", null);
    } else problems.push(`the binding is not serving: ${binding}`);
    // Any record during the rust calls (a fallback, a difference) means some of
    // the answers above were not Rust's.
    if (binding === "ready") for (const entry of records()) problems.push(`recorded ${JSON.stringify(entry)}`);
    return { binding, source: status().source, checked, problems };
}
