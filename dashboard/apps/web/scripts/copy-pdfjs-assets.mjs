/**
 * Stage the pdf.js runtime assets under public/pdfjs so the PDF editor loads its
 * worker, CMaps, standard fonts, ICC profiles and wasm decoders same-origin. The
 * dashboard never pulls assets from a CDN, and these files must match the
 * installed pdfjs-dist exactly, so they are copied at build time instead of
 * being committed. Runs from the web app's predev/prebuild hooks.
 */

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "pdfjs");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

cpSync(join(pdfjsRoot, "build", "pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
    cpSync(join(pdfjsRoot, folder), join(target, folder), { recursive: true });
}

console.log(`Copied pdf.js assets to ${target}`);
