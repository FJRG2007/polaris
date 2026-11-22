import { DOMAINS } from "../../src/registry";
import { describe, expect, it } from "vitest";
import { nativeFileName } from "../../src/native";
// @ts-expect-error - a plain ES module script without type declarations
import { NODE_TARGETS, nodeFileName } from "../../scripts/build-rust.mjs";

describe("domain registry", () => {
    it("lists every domain and its mode, so a change shows up in review", () => {
        // Moving a domain to shadow or rust needs the plan's gates; this table
        // changes in the same commit, next to the ledger row that proves them.
        expect(DOMAINS).toEqual({
            probe: { mode: "ts", ledger: "F4", timeoutMs: 50 }
        });
    });
});

describe("Node binding file names", () => {
    it("the build script writes the file the loader looks for, on every target", () => {
        const targets = NODE_TARGETS as Record<string, { platform: string; arch: string; musl: boolean }>;
        expect(Object.keys(targets).length).toBeGreaterThanOrEqual(5);
        for (const t of Object.values(targets)) expect(nodeFileName(t)).toBe(nativeFileName(t.platform, t.arch, t.musl));
        expect(nativeFileName("linux", "x64", true)).toBe("polaris-core.linux-x64-musl.node");
        expect(nativeFileName("darwin", "arm64", false)).toBe("polaris-core.darwin-arm64.node");
        expect(nativeFileName("win32", "x64", false)).toBe("polaris-core.win32-x64-msvc.node");
    });
});
