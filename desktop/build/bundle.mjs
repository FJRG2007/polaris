/**
 * Bundle the app into `dist/`: the main process and both preloads as CommonJS
 * for Electron's Node, the three local pages' scripts for the browser, and their
 * HTML, stylesheet and mark copied beside them.
 *
 * Bundled so the packaged app needs no `node_modules` at all - zod and fflate are
 * inlined, `electron` is the runtime's own - and forge ships only `dist/` and
 * `package.json` (see `forge.config.js`).
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });

const node = {
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["electron"],
    logLevel: "info",
    legalComments: "none"
};

await build({ ...node, entryPoints: [join(ROOT, "src/main/index.ts")], outfile: join(DIST, "main/index.js") });
await build({
    ...node,
    entryPoints: { app: join(ROOT, "src/preload/app.ts"), local: join(ROOT, "src/preload/local.ts") },
    outdir: join(DIST, "preload")
});
await build({
    bundle: true,
    platform: "browser",
    target: "chrome140",
    format: "iife",
    // The pages carry zod for checking the fields as they are typed.
    minify: true,
    logLevel: "info",
    legalComments: "none",
    entryPoints: ["connect", "api-key", "push"].map((page) => join(ROOT, "src/renderer", `${page}.ts`)),
    outdir: join(DIST, "renderer")
});

mkdirSync(join(DIST, "renderer"), { recursive: true });
for (const file of ["connect.html", "api-key.html", "push.html", "styles.css", "mark.svg"]) {
    copyFileSync(join(ROOT, "src/renderer", file), join(DIST, "renderer", file));
}
// The window icon on Linux; Windows and macOS take theirs from the executable.
copyFileSync(join(ROOT, "assets/icon.png"), join(DIST, "icon.png"));
