/**
 * Stage the pdf.js runtime assets under public/pdfjs so the PDF editor loads its
 * worker, CMaps, standard fonts, ICC profiles and wasm decoders same-origin. The
 * dashboard never pulls assets from a CDN, and these files must match the
 * installed pdfjs-dist exactly, so they are copied at build time instead of
 * being committed. Runs from the web app's predev/prebuild hooks.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const target = join(publicDir, "pdfjs");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

cpSync(join(pdfjsRoot, "build", "pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
    cpSync(join(pdfjsRoot, folder), join(target, folder), { recursive: true });
}

// The annotation layer and the editor's own toolbar ask for their icons at
// /images/, a path the viewer component has baked in with nothing to override
// it. Without them a document with a comment annotation, or a reader reaching
// for the alt-text button, gets a broken icon.
//
// public/images therefore belongs to this script, not to the app: every build
// empties it first. Anything else that needs a public image wants its own
// folder, or the next build deletes it.
const images = join(publicDir, "images");
rmSync(images, { recursive: true, force: true });
cpSync(join(pdfjsRoot, "web", "images"), images, { recursive: true });

console.log(`Copied pdf.js assets to ${target} and ${images}`);
