/**
 * Build the diagram editor into `dist/`.
 *
 * Bundled with esbuild the way the code was written to be built: one ESM entry
 * plus the `*.chunk.ts` modules as entries of their own, because the font
 * subsetter runs in a worker that loads its own chunk by `import.meta.url`, and
 * a chunk that was folded into the main file cannot be started as a worker.
 *
 * Everything this package lists as a dependency stays external, so the app's
 * bundler resolves it once for the whole application instead of carrying a
 * second copy of React, Radix or jotai inside this file.
 *
 * Stylesheets are SCSS, compiled here and collected into `dist/index.css`. The
 * fonts the canvas draws with are emitted as files under `dist/fonts`, which the
 * web app stages under its own origin - see `apps/web/scripts/copy-diagram-assets.mjs`.
 *
 *   npm run build -w @polaris/diagrams
 */

import sass from "sass";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Where `@import "open-color/..."` resolves: the installed package, found the
 *  way Node finds it rather than by a path through node_modules. */
const modules = dirname(
    dirname(createRequire(join(root, "package.json")).resolve("open-color/package.json"))
);

/** SCSS through the compiler the package pins, nothing else. */
const scss = {
    name: "scss",
    setup(builder) {
        builder.onLoad({ filter: /\.scss$/ }, (args) => {
            const result = sass.compile(args.path, {
                loadPaths: [dirname(args.path), modules],
                style: "compressed"
            });
            return {
                contents: result.css,
                loader: "css",
                resolveDir: dirname(args.path),
                watchFiles: result.loadedUrls.map((url) => fileURLToPath(url))
            };
        });
    }
};

rmSync(join(root, "dist"), { recursive: true, force: true });

await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts", "src/editor/**/*.chunk.ts"],
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "[dir]/[name]",
    outbase: "src",
    outdir: "dist",
    bundle: true,
    splitting: true,
    format: "esm",
    target: "es2020",
    minify: true,
    legalComments: "linked",
    // A palette shipped as a bare JSON module is bundled instead: imported from
    // outside a bundler (a test runner, Node) it would need an import attribute.
    external: [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {})
    ]
        .filter((name) => name !== "open-color")
        .flatMap((name) => [name, `${name}/*`]),
    plugins: [scss],
    loader: { ".woff2": "file" },
    jsx: "automatic",
    define: {
        "import.meta.env": JSON.stringify({ MODE: "production", DEV: false, PROD: true })
    },
    logLevel: "warning"
});

console.log(`[diagrams] built into ${resolve(root, "dist")}`);
