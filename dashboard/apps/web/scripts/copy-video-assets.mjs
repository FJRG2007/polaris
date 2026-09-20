/**
 * Stage the video runtime under public/video.
 *
 * One thing lives here: the selfie-segmentation model that decides which pixels
 * of a camera frame are the person, so a call can blur or replace everything
 * else. It is the same model Jitsi and Nextcloud Talk run, and it is an
 * Emscripten build - a loader script, a wasm binary and a pair of weights that
 * the loader fetches by name from wherever the loader itself was served. None of
 * it can be bundled: the loader is a classic script that exports a global, and
 * the files it asks for have to exist as files this origin will hand over.
 *
 * Every file the package ships is staged rather than a list of the ones that
 * looked necessary. Which of the two wasm builds runs is decided in the browser
 * from what it supports, the loader appends its own suffixes to ask for the
 * rest, and a name this script had not thought of is a 404 that turns into a
 * camera with no background on it - after the browser has already downloaded
 * five megabytes to find out.
 *
 * Nothing here comes from a CDN, and the files must match the installed package
 * exactly, so they are copied at build time rather than committed. Runs from the
 * web app's predev/prebuild hooks, beside the audio and pdf.js staging.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@mediapipe/selfie_segmentation/package.json"));
const manifest = require("@mediapipe/selfie_segmentation/package.json");
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "video");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

/** What the package carries for the reader of it rather than for the browser. */
const notForTheBrowser = new Set(["package.json", "README.md", "index.d.ts"]);

for (const file of readdirSync(root)) {
    if (notForTheBrowser.has(file)) continue;
    copyFileSync(join(root, file), join(target, file));
}

// The package ships no licence file of its own, and these are somebody else's
// binaries being served from Polaris's own origin. What it is and where its
// terms are, beside the files, so the answer travels with them.
writeFileSync(
    join(target, "NOTICE.txt"),
    [
        `${manifest.name} ${manifest.version}`,
        `Copyright ${manifest.author ?? "Google LLC"}`,
        "Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0",
        `${manifest.homepage}`,
        ""
    ].join("\n")
);

console.log(`Copied video assets to ${target}`);
