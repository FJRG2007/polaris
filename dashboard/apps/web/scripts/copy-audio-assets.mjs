/**
 * Stage the audio runtime under public/audio.
 *
 * Two things live here and neither can be bundled. The noise-suppression worklet
 * is loaded by URL (`audioWorklet.addModule`) and its model is fetched as a wasm
 * binary, so both have to exist as files the browser can ask this origin for.
 * The MP3 encoder is a file for a second reason as well: every MP3 encoder there
 * is descends from LAME and carries its licence, which asks that somebody be
 * able to replace it with a build of their own - true of a file served from
 * here, not true of something compiled into the application. Its licence is
 * copied beside it so the terms travel with the code.
 *
 * Nothing here comes from a CDN, and the files must match the installed packages
 * exactly, so they are copied at build time rather than committed. Runs from the
 * web app's predev/prebuild hooks, beside the pdf.js and Minecraft icon staging.
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

// The encoder's own build, resolved the same way. The self-contained one rather
// than the module: it is loaded with a script tag, by a page that has already
// decided it needs it.
const lame = dirname(require.resolve("@breezystack/lamejs"));
copyFileSync(join(lame, "lamejs.iife.js"), join(target, "mp3-encoder.js"));
copyFileSync(join(dirname(lame), "LICENSE"), join(target, "mp3-encoder.LICENSE.txt"));

console.log(`Copied audio assets to ${target}`);
