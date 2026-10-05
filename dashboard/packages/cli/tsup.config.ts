/**
 * One file, everything inside it.
 *
 * The CLI is released on GitHub (`cli-v*` tags, `.github/workflows/cli.yml`) and
 * also served by each Polaris at `/cli/polaris.mjs`, and it runs with the
 * developer's own Node, so it cannot count on a `node_modules` beside it: zod and
 * every other import are bundled in. Its version is this package's own, stamped
 * at build time, so `plr --version` names the release a tag was cut from.
 */

import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const cli = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
};

export default defineConfig({
    entry: { polaris: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    outDir: "dist",
    clean: true,
    bundle: true,
    splitting: false,
    sourcemap: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: ".mjs" }),
    banner: { js: "#!/usr/bin/env node" },
    define: { __CLI_VERSION__: JSON.stringify(cli.version) }
});
