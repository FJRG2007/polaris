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
import { join } from "node:path";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * The skills, inlined into the bundle.
 *
 * Polaris departure. Upstream ships these as files beside the bundle and the
 * runtime reads them off disk, which works when the runtime is an npm package
 * on the runner. Polaris serves the bundle as two `.mjs` files over HTTP, so
 * nothing is ever beside it - every run died with "bundled skill not found" and
 * the paths it had looked in. Anything the runtime needs has to be inside the
 * file, not next to it.
 *
 * Read at build time and handed to the bundle as one JSON string, which the
 * source path ignores: `skills.ts` still falls back to reading the directory, so
 * running from source behaves exactly as it did.
 */
const bundledSkills = Object.fromEntries(
    readdirSync("./skills", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name, readFileSync(join("skills", entry.name, "SKILL.md"), "utf8")])
);

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
    // Doubly stringified on purpose: `define` substitutes source text, so the
    // value has to be a JS expression - here, a string literal the runtime
    // parses.
    define: { __POLARIS_BUNDLED_SKILLS__: JSON.stringify(JSON.stringify(bundledSkills)) },
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
