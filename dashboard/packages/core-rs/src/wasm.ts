/**
 * Loading the WebAssembly binding (`crates/polaris-core-wasm`, built by
 * `scripts/build-rust.mjs` into `wasm/`) in a browser, the extension, a mobile
 * WebView or, for parity tests, Node.
 *
 * Nothing is fetched when this module is imported or when `useWasm` is called:
 * the module is requested the first time a domain in `shadow` or `rust` mode is
 * called, or when a screen calls `ready()` after painting. Until it arrives the
 * TypeScript implementation answers, so first paint never waits on it.
 */

import { pickBinding } from "./binding";
import { setBindingSource } from "./runtime";

/** What wasm-bindgen's `--target web` glue module exports. */
interface WasmGlue {
    default(input: { module_or_path: unknown }): Promise<unknown>;
}

/**
 * Load the glue module at `glueUrl` and instantiate it with `wasm` (a URL, a
 * `Response`, or the module's bytes), returning the binding's functions.
 */
export async function loadWasmBinding(glueUrl: string, wasm: unknown) {
    const glue = (await import(/* webpackIgnore: true */ /* @vite-ignore */ glueUrl)) as WasmGlue;
    await glue.default({ module_or_path: wasm });
    return pickBinding(glue, "wasm");
}

/** Serve Rust-backed domains from the WebAssembly binding, loaded lazily by `load`. */
export function useWasm(load: () => Promise<unknown>) {
    setBindingSource({ kind: "wasm", load: async () => pickBinding(await load(), "wasm") });
}
