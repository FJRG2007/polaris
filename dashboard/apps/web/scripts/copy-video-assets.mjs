/**
 * Stage the video runtime under public/video.
 *
 * Two things live here, both for the camera backgrounds a call can put behind
 * somebody:
 *
 * - MediaPipe's vision runtime (`@mediapipe/tasks-vision`): a loader script and
 *   a wasm binary, in a SIMD build and a build for browsers without SIMD. Which
 *   one runs is decided in the browser, so both are staged. The bundle that
 *   drives them is imported normally and split out by the bundler; only the
 *   wasm has to exist as files this origin will hand over.
 * - The selfie segmenter model that decides which pixels of a frame are the
 *   person. It is not in the package - Google publishes it on its own - so it
 *   is committed under `assets/video` and copied from there.
 *
 * Nothing here comes from a CDN, and the runtime must match the installed
 * package exactly, so it is copied at build time rather than committed. Runs
 * from the web app's predev/prebuild hooks, beside the audio and pdf.js staging.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
// The package exports no "./package.json", so its root is found from its entry.
const root = dirname(require.resolve("@mediapipe/tasks-vision"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const models = join(app, "assets", "video");
const target = join(app, "public", "video");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

/** The ES-module build of the runtime, which the camera filter never asks for. */
const notForTheBrowser = new Set([
    "vision_wasm_module_internal.js",
    "vision_wasm_module_internal.wasm"
]);

for (const file of readdirSync(join(root, "wasm"))) {
    if (notForTheBrowser.has(file)) continue;
    copyFileSync(join(root, "wasm", file), join(target, file));
}

for (const file of readdirSync(models)) {
    copyFileSync(join(models, file), join(target, file));
}

// Somebody else's binaries, served from Polaris's own origin. What they are and
// where their terms are, beside the files, so the answer travels with them.
writeFileSync(
    join(target, "NOTICE.txt"),
    [
        `${manifest.name} ${manifest.version}`,
        "selfie_segmenter.tflite (MediaPipe image segmenter, selfie segmenter, float16)",
        "Copyright Google LLC",
        "Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0",
        "https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter",
        ""
    ].join("\n")
);

console.log(`Copied video assets to ${target}`);
