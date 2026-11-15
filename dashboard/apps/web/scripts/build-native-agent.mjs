// @ts-check

/**
 * Builds `polaris-agent`, the native session engine, as one self-contained
 * file (`native-agent/polaris-agent.mjs`), every dependency inlined: the
 * session container and the person's computer have no node_modules to resolve
 * against. Served by the instance at `/api/agents/native/bundle`, the same way
 * the agent runtime's bundle is.
 *
 * Runs before `next build` (package.json `prebuild`), so the image carries it.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "native-agent", "polaris-agent.mjs");

rmSync(outfile, { force: true });
mkdirSync(dirname(outfile), { recursive: true });

await build({
    entryPoints: [join(root, "src", "lib", "polar", "native", "bin.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    minify: false,
    sourcemap: false,
    treeShaking: true,
    alias: { "@": join(root, "src") },
    // CommonJS dependencies inside an ESM bundle need these globals.
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);"
    },
    logLevel: "warning"
});

console.log("polaris-agent bundle built");
