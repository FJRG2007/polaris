/**
 * How a deployed commit's lockfiles travel to the dependency scan: the paths
 * that count as lockfiles, the stored form read back as untrusted input, and
 * the build context that puts them on top of the scanner's image. The file
 * contents are fixture data.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
    decodeLockfiles,
    dependencyContext,
    encodeLockfiles,
    isLockfilePath,
    lockfileDirs
} from "../src/lockfiles.js";

const SCANNER = `anchore/grype:v0.0.0@sha256:${"a".repeat(64)}`;
const FILES = [
    { path: "package-lock.json", body: Buffer.from('{"lockfileVersion":3,"packages":{}}\n') },
    { path: "services/api/go.sum", body: Buffer.from("example.test/fixture v1.0.0 h1:fixture=\n") }
];

describe("where a service's lockfiles are looked for", () => {
    it("is the repository root and every folder down to the service's", () => {
        expect(lockfileDirs("")).toEqual([""]);
        expect(lockfileDirs("./services/api/")).toEqual(["", "services", "services/api"]);
        expect(lockfileDirs(["services", "api"].join(String.fromCharCode(92)))).toEqual(["", "services", "services/api"]);
    });

    it("is nowhere for a root directory that leaves the repository", () => {
        expect(lockfileDirs("../elsewhere")).toBeNull();
    });
});

describe("a lockfile path", () => {
    it("is a known name inside the repository", () => {
        expect(isLockfilePath("pnpm-lock.yaml")).toBe(true);
        expect(isLockfilePath("services/api/Cargo.lock")).toBe(true);
        for (const bad of ["../package-lock.json", "a//yarn.lock", "/etc/passwd", "notes.txt", "x/../go.sum", `${"d/".repeat(60)}go.sum`]) {
            expect(isLockfilePath(bad), bad).toBe(false);
        }
    });
});

describe("stored lockfiles", () => {
    it("read back as they were written", () => {
        expect(decodeLockfiles(encodeLockfiles(FILES))).toEqual(FILES);
    });

    it("stop at the first record that is not a lockfile, keeping what came before", () => {
        const evil = Buffer.concat([
            encodeLockfiles(FILES.slice(0, 1)),
            Buffer.from(`${JSON.stringify({ path: "../../etc/cron.d/x", size: 1 })}\nx`)
        ]);
        expect(decodeLockfiles(evil).map((f) => f.path)).toEqual(["package-lock.json"]);
    });

    it("never read past the end of what is stored", () => {
        const cut = encodeLockfiles(FILES).subarray(0, -5);
        expect(decodeLockfiles(cut).map((f) => f.path)).toEqual(["package-lock.json"]);
        expect(decodeLockfiles(Buffer.from("not json\n"))).toEqual([]);
    });
});

describe("the scan's build context", () => {
    it("is a tar of a Dockerfile on the pinned scanner and the lockfiles under src", () => {
        const archive = dependencyContext(FILES, SCANNER);
        expect(archive.length % 512).toBe(0);
        expect(archive.subarray(512, 1024).toString("utf8")).toContain(`FROM ${SCANNER}\nCOPY src /src\n`);
        const listed = spawnSync("tar", ["-tf", "-"], { input: archive });
        if (listed.status === 0) {
            expect(listed.stdout.toString().trim().split(/\r?\n/)).toEqual([
                "Dockerfile",
                "src/",
                "src/services/",
                "src/services/api/",
                "src/package-lock.json",
                "src/services/api/go.sum"
            ]);
        }
    });

    it("refuses a scanner that is not named by its digest", () => {
        expect(() => dependencyContext(FILES, "anchore/grype:latest")).toThrow();
        expect(() => dependencyContext(FILES, `x\nRUN id@sha256:${"a".repeat(64)}`)).toThrow();
    });
});
