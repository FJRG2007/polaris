/**
 * The WebAssembly binding as an artifact ships it (docs/rust-core-plan.md, F6):
 * the glue module and the `.wasm` from `wasm/` (written by build-rust.mjs),
 * renamed with a digest of their contents so a browser can cache them for as
 * long as it likes, plus a `manifest.json` naming the two. The web app stages
 * them into `public/core-rs/` and the extension into its own `core-rs/`; the
 * loader reads the manifest, and `smoke.mjs --wasm` checks the staged copy.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const wasmDir = fileURLToPath(new URL("../wasm/", import.meta.url));
const GLUE = "polaris_core_wasm.js";
const WASM = "polaris_core_wasm_bg.wasm";

/** True when a build must carry the binding (CI sets it); a local or operator build may go without. */
export function bindingRequired() {
    return process.env.POLARIS_CORE_RS_REQUIRED === "1";
}

/**
 * The files to ship, or `null` when the binding was not built (the facades then
 * answer with TypeScript). Throws instead of returning `null` when `required`.
 */
export function wasmAssets({ required = bindingRequired() } = {}) {
    const glue = join(wasmDir, GLUE);
    const wasm = join(wasmDir, WASM);
    if (!existsSync(glue) || !existsSync(wasm)) {
        if (required) throw new Error(`the WebAssembly binding is not built (${wasmDir}): run npm run build:rust -w @polaris/core-rs`);
        return null;
    }
    const digest = createHash("sha256").update(readFileSync(glue)).update(readFileSync(wasm)).digest("hex").slice(0, 16);
    const manifest = { glue: `polaris_core_wasm.${digest}.js`, wasm: `polaris_core_wasm_bg.${digest}.wasm` };
    return {
        files: [
            { src: glue, name: manifest.glue },
            { src: wasm, name: manifest.wasm }
        ],
        manifest
    };
}
