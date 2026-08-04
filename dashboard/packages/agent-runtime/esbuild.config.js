// @ts-check

/**
 * Builds the self-contained runtime bundle.
 *
 * The output is one file with every dependency inlined, because the places it
 * runs have no node_modules to resolve against: a GitHub Actions job that
 * downloads it from the Polaris instance, a Polaris runner, and the container
 * Polaris starts on its own box. Two entrypoints, matching action.yml - the run
 * itself, and the always-run post step that persists state a cancelled or
 * timed-out run would otherwise lose.
 *
 * The `dist/shared` and `dist/control` surfaces the dashboard imports are built
 * separately by tsup (see package.json), with dependencies left external.
 */

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("./dist/runtime.mjs", { force: true });
rmSync("./dist/post.mjs", { force: true });
mkdirSync("./dist", { recursive: true });

/** Strips the shebang esbuild otherwise leaves mid-file. */
const stripShebang = {
    name: "strip-shebang",
    setup(build) {
        build.onEnd((result) => {
            if (result.errors.length > 0) return;
            const outfile = build.initialOptions.outfile;
            if (!outfile) return;
            try {
                const content = readFileSync(outfile, "utf8");
                if (content.startsWith("#!")) {
                    writeFileSync(outfile, content.slice(content.indexOf("\n") + 1));
                }
            } catch {
                // The build failed before writing; esbuild has already reported why.
            }
        });
    }
};

/** @type {import("esbuild").BuildOptions} */
const shared = {
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    minify: false,
    sourcemap: false,
    treeShaking: true,
    // Optional peer dependencies of the schema libraries. Nothing imports them,
    // and marking them external is what stops esbuild failing on the absence.
    external: ["@valibot/to-json-schema", "effect", "sury"],
    // CommonJS dependencies get bundled into an ESM output, so they need these
    // three globals to exist. The names are prefixed to avoid colliding with
    // anything the bundle itself declares.
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; import { fileURLToPath as __fileURLToPath } from 'url'; import { dirname as __dirnameFn } from 'path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameFn(__filename);"
    },
    plugins: [stripShebang]
};

await build({ ...shared, entryPoints: ["./entry.ts"], outfile: "./dist/runtime.mjs" });
await build({ ...shared, entryPoints: ["./entryPost.ts"], outfile: "./dist/post.mjs" });

// The agent reads these at run time with readFileSync, so they have to sit next
// to the bundle rather than inside it.
cpSync("./skills", "./dist/skills", { recursive: true });

console.log("agent runtime bundle built");
