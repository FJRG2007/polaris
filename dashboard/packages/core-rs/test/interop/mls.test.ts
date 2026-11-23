/**
 * Cross-target MLS interop (docs/rust-core-plan.md, E3): the real Node binding
 * (napi - what the server runs for its own members, Polar and webhook service
 * members, proposal section 7) and the real WebAssembly chunk (what a browser
 * runs) in one process, as members of the same groups. Every assignment of the
 * three members to the two targets runs the whole group life - Welcome, both
 * directions of application messages, a self-update, an external join, a
 * removal - on both suites, then the crash/restart journal and a store carried
 * from one target to the other. Needs both builds:
 *
 *   npm run build:rust -w @polaris/core-rs   (or the CI artifacts in place)
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { nativeFileName } from "../../src/native";
import { packageDir, requireBuilt } from "../support/files";
import { runGroupLife, runRestarts, runStoreHandover, SUITES, type MlsMemberClass } from "../support/mls";

const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
const musl = process.platform === "linux" && !report.header?.glibcVersionRuntime;
const nativePath = requireBuilt(join(packageDir, "native", nativeFileName(process.platform, process.arch, musl)));
const napi = (createRequire(import.meta.url)(nativePath) as { MlsMember: MlsMemberClass }).MlsMember;

const glueUrl = pathToFileURL(requireBuilt(join(packageDir, "wasm-mls", "polaris_core_mls.js"))).href;
const glue = (await import(/* @vite-ignore */ glueUrl)) as {
    default(init: { module_or_path: unknown }): Promise<unknown>;
    MlsMember: MlsMemberClass;
};
await glue.default({ module_or_path: readFileSync(requireBuilt(join(packageDir, "wasm-mls", "polaris_core_mls_bg.wasm"))) });
const wasm = glue.MlsMember;

const TARGETS = { napi, wasm } as const;
type Target = keyof typeof TARGETS;
const NAMES = Object.keys(TARGETS) as Target[];

/** Every assignment of alice (the group's creator), bob and carol to a target, except the two single-target ones. */
const CASTS = NAMES.flatMap((alice) => NAMES.flatMap((bob) => NAMES.map((carol) => ({ alice, bob, carol })))).filter(
    (cast) => new Set(Object.values(cast)).size > 1
);

const label = (cast: Record<string, Target>) => Object.entries(cast).map(([role, target]) => `${role}=${target}`).join(" ");
const classes = (cast: { alice: Target; bob: Target; carol: Target }) => ({
    alice: TARGETS[cast.alice],
    bob: TARGETS[cast.bob],
    carol: TARGETS[cast.carol]
});

describe("MLS across napi and wasm", () => {
    for (const suite of SUITES) {
        const hex = `0x${suite.toString(16).padStart(4, "0")}`;
        for (const cast of CASTS) it(`group life on ${hex}, ${label(cast)}`, () => runGroupLife(classes(cast), suite));
        for (const cast of CASTS.filter((c) => c.alice !== c.bob))
            it(`restarts on ${hex}, ${label({ alice: cast.alice, bob: cast.bob })}`, () => runRestarts(classes(cast), suite));
        for (const [from, to] of [["napi", "wasm"], ["wasm", "napi"]] as const)
            it(`a ${from} store restores on ${to} on ${hex}`, () => runStoreHandover(TARGETS[from], TARGETS[to], suite));
    }
});
