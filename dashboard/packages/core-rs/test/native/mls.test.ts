/**
 * The MLS class of the real Node binding (built by `npm run build:rust`),
 * through the shared group-life scenario on both suites.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { nativeFileName, nativeMlsMember } from "../../src/native";
import { BindingMissingError } from "../../src/binding";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("nativeMlsMember", () => {
    it("loads the binding's class for the server's members", () => expect(nativeMlsMember()).toBe(MlsMember));
    it("throws BindingMissingError where no binding is built", () =>
        expect(() => nativeMlsMember(mkdtempSync(join(tmpdir(), "core-rs-absent-")))).toThrow(BindingMissingError));
});
