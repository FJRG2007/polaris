/**
 * Bundles the plugin into the one file the Stream Deck app runs,
 * `io.github.fjrg2007.polaris.sdPlugin/bin/plugin.js`, with the SDK and its
 * dependencies inside it. The shape `streamdeck create` sets up.
 */

import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "io.github.fjrg2007.polaris.sdPlugin";

/** @type {import("rollup").RollupOptions} */
export default {
    input: "src/plugin.ts",
    output: {
        file: `${sdPlugin}/bin/plugin.js`,
        format: "es",
        sourcemap: false
    },
    plugins: [
        typescript({ include: ["src/**/*.ts"], noEmitOnError: true }),
        nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
        commonjs(),
        {
            name: "emit-module-package-file",
            generateBundle() {
                this.emitFile({
                    fileName: "package.json",
                    source: `{ "type": "module" }`,
                    type: "asset"
                });
            }
        }
    ]
};
