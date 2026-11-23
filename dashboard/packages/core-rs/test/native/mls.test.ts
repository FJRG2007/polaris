/**
 * The MLS class of the real Node binding (built by `npm run build:rust`),
 * through the shared group-life scenario on both suites.
 */

import { join } from "node:path";
import { describe, it } from "vitest";
import { createRequire } from "node:module";
import { nativeFileName } from "../../src/native";
import { packageDir, requireBuilt } from "../support/files";
import { runGroupLife, runRefusals, runRestarts, SUITES, type MlsMemberClass } from "../support/mls";

const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
const musl = process.platform === "linux" && !report.header?.glibcVersionRuntime;
const builtPath = requireBuilt(join(packageDir, "native", nativeFileName(process.platform, process.arch, musl)));
const { MlsMember } = createRequire(import.meta.url)(builtPath) as { MlsMember: MlsMemberClass };

describe("napi MlsMember", () => {
    for (const suite of SUITES) it(`runs a group's life on suite 0x${suite.toString(16)}`, () => runGroupLife(MlsMember, suite));
    it("carries every refusal's code", () => runRefusals(MlsMember));
    for (const suite of SUITES) it(`restarts from its store around a commit on suite 0x${suite.toString(16)}`, () => runRestarts(MlsMember, suite));
});
