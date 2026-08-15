/**
 * Stage the noise-suppression runtime under public/audio.
 *
 * The worklet is loaded by URL (`audioWorklet.addModule`) and the model is
 * fetched as a wasm binary, so neither can be bundled - they have to exist as
 * files the browser can ask this origin for. Nothing here comes from a CDN, and
 * the files must match the installed package exactly, so they are copied at
 * build time rather than committed. Runs from the web app's predev/prebuild
 * hooks, beside the pdf.js and Minecraft icon staging.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

// Resolved through one of the package's own exported subpaths: it does not
// export its package.json, so there is nothing else to point at.
const require = createRequire(import.meta.url);
const root = dirname(dirname(require.resolve("@sapphi-red/web-noise-suppressor")));
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

/** What the browser fetches, and under what name. Two models: the small one that
 *  runs anywhere, and the better one that is tried first. */
const files = [
    ["dist/gtcrn/workletProcessor.js", "gtcrn-worklet.js"],
    ["dist/gtcrn.wasm", "gtcrn.wasm"],
    ["dist/rnnoise/workletProcessor.js", "rnnoise-worklet.js"],
    ["dist/rnnoise.wasm", "rnnoise.wasm"],
    ["dist/rnnoise_simd.wasm", "rnnoise_simd.wasm"]
];

for (const [from, to] of files) {
    copyFileSync(join(root, from), join(target, to));
}

console.log(`Copied audio filter assets to ${target}`);
