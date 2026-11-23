/**
 * Bundle the app into `dist/`: the main process and the preloads as CommonJS
 * for Electron's Node, the three local pages' scripts for the browser, and their
 * HTML, stylesheet and mark copied beside them.
 *
 * Bundled so the packaged app needs no `node_modules` at all - zod and fflate are
 * inlined, `electron` is the runtime's own - and forge ships only `dist/` and
 * `package.json` (see `forge.config.js`).
 */

import { build } from "esbuild";
import { launcherCss, ownPackages } from "./launcher-ui.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { CORE_RS_NATIVE, mainNode, node } from "./node-build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });

await build({ ...mainNode, entryPoints: [join(ROOT, "src/main/index.ts")], outfile: join(DIST, "main/index.js") });
await build({
    ...node,
    entryPoints: {
        app: join(ROOT, "src/preload/app.ts"),
        local: join(ROOT, "src/preload/local.ts"),
        usb: join(ROOT, "src/preload/usb.ts"),
        launcher: join(ROOT, "src/preload/launcher.ts")
    },
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
    entryPoints: ["connect", "api-key", "push", "tv", "usb", "overlay", "voice-widget", "updating"].map((page) => join(ROOT, "src/renderer", `${page}.ts`)),
    outdir: join(DIST, "renderer")
});
// The launcher draws the dashboard's own search panel with React, and its
// stylesheet is the dashboard's tokens and Tailwind classes (build/launcher-ui.mjs).
await build({
    bundle: true,
    platform: "browser",
    target: "chrome140",
    format: "iife",
    minify: true,
    logLevel: "info",
    legalComments: "none",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [ownPackages()],
    entryPoints: [join(ROOT, "src/renderer/launcher.tsx")],
    outdir: join(DIST, "renderer")
});
mkdirSync(join(DIST, "renderer"), { recursive: true });
writeFileSync(join(DIST, "renderer", "launcher.css"), await launcherCss());

mkdirSync(join(DIST, "renderer"), { recursive: true });
for (const file of ["connect.html", "api-key.html", "push.html", "tv.html", "usb.html", "overlay.html", "voice-widget.html", "updating.html", "launcher.html", "styles.css", "mark.svg"]) {
    copyFileSync(join(ROOT, "src/renderer", file), join(DIST, "renderer", file));
}
// The dashboard's face, so these windows read the way it does.
mkdirSync(join(DIST, "renderer", "fonts"), { recursive: true });
for (const file of ["IBMPlexSans-Regular.woff2", "IBMPlexSans-Medium.woff2", "IBMPlexSans-SemiBold.woff2", "NOTICE.md"]) {
    copyFileSync(join(ROOT, "src/renderer/fonts", file), join(DIST, "renderer", "fonts", file));
}
// The window icon on Linux - Windows and macOS take theirs from the executable -
// and the tray icon on Windows and Linux.
copyFileSync(join(ROOT, "assets/icon.png"), join(DIST, "icon.png"));
copyFileSync(join(ROOT, "assets/icon.ico"), join(DIST, "icon.ico"));

// The Rust core's Node binding for this platform (see CORE_RS_NATIVE). None
// built, as without a Rust toolchain, is not an error: the facades answer with
// TypeScript. desktop.yml builds it and checks the packaged copy loads.
const coreNative = (existsSync(CORE_RS_NATIVE) ? readdirSync(CORE_RS_NATIVE, { withFileTypes: true }) : []).filter(
    (entry) => entry.isFile() && entry.name.startsWith(`polaris-core.${process.platform}-`) && entry.name.endsWith(".node")
);
if (coreNative.length) mkdirSync(join(DIST, "native"), { recursive: true });
for (const entry of coreNative) copyFileSync(join(CORE_RS_NATIVE, entry.name), join(DIST, "native", entry.name));
