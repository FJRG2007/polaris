/**
 * The MLS class of the real WebAssembly chunk (wasm-mls/, built by
 * `npm run build:rust`) in Node, through the shared group-life scenario on
 * both suites. The Rust MLS suites themselves run in browsers through
 * wasm-bindgen-test (.github/workflows/rust-core.yml).
 */

import { join } from "node:path";
import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { packageDir, requireBuilt } from "../support/files";
import { runGroupLife, runRefusals, SUITES, type MlsMemberClass } from "../support/mls";

const glueUrl = pathToFileURL(requireBuilt(join(packageDir, "wasm-mls", "polaris_core_mls.js"))).href;
const wasmBytes = readFileSync(requireBuilt(join(packageDir, "wasm-mls", "polaris_core_mls_bg.wasm")));
const glue = (await import(/* @vite-ignore */ glueUrl)) as {
    default(init: { module_or_path: unknown }): Promise<unknown>;
    MlsMember: MlsMemberClass;
};
await glue.default({ module_or_path: wasmBytes });

describe("wasm MlsMember", () => {
    for (const suite of SUITES)
        it(`runs a group's life on suite 0x${suite.toString(16)}`, () => runGroupLife(glue.MlsMember, suite));
    it("carries every refusal's code", () => runRefusals(glue.MlsMember));
});
