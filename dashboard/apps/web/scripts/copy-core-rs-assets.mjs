/**
 * Stage the Rust core's WebAssembly binding under public/core-rs, named by a
 * digest of its contents, with a manifest.json naming the two files
 * (packages/core-rs/scripts/wasm-assets.mjs). The browser fetches them lazily,
 * only when a screen uses a Rust-backed domain. The MLS build is staged the same
 * way under public/core-rs/mls, fetched only by encrypted chat. Not built (no Rust toolchain,
 * as on an operator's own build) is not an error: the facades answer with
 * TypeScript. CI sets POLARIS_CORE_RS_REQUIRED=1, which makes it one.
 * Runs from the web app's predev/prebuild hooks.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { wasmAssets, wasmMlsAssets } from "../../../packages/core-rs/scripts/wasm-assets.mjs";

const target = join(fileURLToPath(new URL("..", import.meta.url)), "public", "core-rs");

rmSync(target, { recursive: true, force: true });
const assets = wasmAssets();
if (!assets) {
    console.log("The Rust core's WebAssembly binding is not built; the web bundle ships without it");
} else {
    mkdirSync(target, { recursive: true });
    for (const file of assets.files) copyFileSync(file.src, join(target, file.name));
    writeFileSync(join(target, "manifest.json"), `${JSON.stringify(assets.manifest)}\n`);
    console.log(`Copied the Rust core's WebAssembly binding to ${target}`);
}

const mls = wasmMlsAssets();
if (mls) {
    const mlsTarget = join(target, "mls");
    mkdirSync(mlsTarget, { recursive: true });
    for (const file of mls.files) copyFileSync(file.src, join(mlsTarget, file.name));
    writeFileSync(join(mlsTarget, "manifest.json"), `${JSON.stringify(mls.manifest)}
`);
    console.log(`Copied the Rust core's MLS WebAssembly binding to ${mlsTarget}`);
}
