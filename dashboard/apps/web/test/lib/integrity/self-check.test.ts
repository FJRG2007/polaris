import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrityChecker, IntegrityManifest } from "@polaris/core/integrity";
import { checkOwnCode, webDir } from "@/lib/integrity/self-check";

const STAMP = "0123456789abcdef";
const digest = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

function source(manifest: IntegrityManifest | null): IntegrityChecker {
    return {
        stamp: async () => STAMP,
        manifest: async () => manifest,
        check: async () => {
            throw new Error("not used");
        },
        forget: () => undefined
    };
}

describe("server code self-check", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "polaris-integrity-"));
        mkdirSync(join(dir, ".next", "static", "chunks"), { recursive: true });
        mkdirSync(join(dir, "public"), { recursive: true });
        writeFileSync(join(dir, ".next", "static", "chunks", "a.js"), "a");
        writeFileSync(join(dir, "public", "sw.js"), "sw");
        writeFileSync(join(dir, "public", "logo.svg"), "<svg/>");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const manifest = (files: Record<string, string>): IntegrityManifest => ({
        schema: 1,
        build: STAMP,
        prefixes: ["/_next/static/"],
        files
    });

    it("finds the web app's folder from the image's working directory", () => {
        expect(webDir(dir)).toBe(dir);
        expect(webDir(join(dir, "nowhere"))).toBeNull();
    });

    it("verifies files that match the signed manifest", async () => {
        const result = await checkOwnCode({
            stamp: STAMP,
            dir,
            checker: source(manifest({ "/_next/static/chunks/a.js": digest("a"), "/sw.js": digest("sw") }))
        });
        expect(result.verdict).toEqual({ kind: "verified", build: STAMP, checked: 2 });
        expect(result.missing).toBe(0);
    });

    it("reports a changed file and one the build never had", async () => {
        writeFileSync(join(dir, ".next", "static", "chunks", "extra.js"), "evil");
        const result = await checkOwnCode({
            stamp: STAMP,
            dir,
            checker: source(manifest({ "/_next/static/chunks/a.js": digest("a"), "/sw.js": digest("other") }))
        });
        expect(result.verdict).toEqual({
            kind: "changed",
            build: STAMP,
            paths: ["/_next/static/chunks/extra.js", "/sw.js"]
        });
    });

    it("cannot verify a source build or a version with no manifest", async () => {
        expect((await checkOwnCode({ stamp: null, dir })).verdict).toEqual({ kind: "unverifiable", reason: "no-stamp" });
        expect((await checkOwnCode({ stamp: STAMP, dir, checker: source(null) })).verdict).toEqual({
            kind: "unverifiable",
            reason: "no-manifest"
        });
    });
});
