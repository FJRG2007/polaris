import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    checkedPath,
    servedPath,
    judge,
    manifestUrl,
    readManifest,
    readStamp,
    sriDigest,
    type IntegrityManifest
} from "../src/integrity";

const STAMP = "0123456789abcdef";
const ORIGIN = "https://polaris.example";
const A = `sha256-${createHash("sha256").update("a").digest("base64")}`;
const B = `sha256-${createHash("sha256").update("b").digest("base64")}`;

const manifest: IntegrityManifest = {
    schema: 1,
    build: STAMP,
    prefixes: ["/_next/static/"],
    files: { "/_next/static/chunks/a.js": A, "/sw.js": B }
};

describe("integrity", () => {
    it("hashes the way the build script does", async () => {
        expect(await sriDigest(new TextEncoder().encode("a"))).toBe(A);
    });

    it("reads only a well-formed stamp", () => {
        expect(readStamp(STAMP)).toBe(STAMP);
        expect(readStamp(null)).toBeNull();
        expect(readStamp("../../etc")).toBeNull();
        expect(readStamp("0123456789ABCDEF")).toBeNull();
    });

    it("names the manifest by the stamp", () => {
        expect(manifestUrl(STAMP)).toMatch(/\/integrity\/manifests\/0123456789abcdef\.json$/);
    });

    it("refuses a manifest for another build or of another shape", () => {
        const text = JSON.stringify(manifest);
        expect(readManifest(text, STAMP)).toEqual(manifest);
        expect(readManifest(text, "fedcba9876543210")).toBeNull();
        expect(readManifest("<html>", STAMP)).toBeNull();
        expect(readManifest(JSON.stringify({ ...manifest, files: { "/a.js": "md5-x" } }), STAMP)).toBeNull();
    });

    it("checks only same-origin code, without the query", () => {
        expect(checkedPath(`${ORIGIN}/_next/static/chunks/a.js?dpl=1`, ORIGIN)).toBe("/_next/static/chunks/a.js");
        expect(checkedPath("/_next/static/css/x.css", ORIGIN)).toBe("/_next/static/css/x.css");
        expect(checkedPath("https://cdn.example/_next/static/a.js", ORIGIN)).toBeNull();
        expect(checkedPath(`${ORIGIN}/_next/static/media/font.woff2`, ORIGIN)).toBeNull();
        expect(checkedPath("not a url", "nope")).toBeNull();
    });

    it("checks a dynamic route's chunk under the name the manifest gives it", () => {
        expect(
            checkedPath(`${ORIGIN}/_next/static/chunks/app/(app)/game-servers/%5B%5B...path%5D%5D/page-c8.js`, ORIGIN)
        ).toBe("/_next/static/chunks/app/(app)/game-servers/[[...path]]/page-c8.js");
        expect(checkedPath(`${ORIGIN}/_next/static/chunks/app/tasks/l/%5BlistId%5D/page.js`, ORIGIN)).toBe(
            "/_next/static/chunks/app/tasks/l/[listId]/page.js"
        );
        expect(checkedPath(`${ORIGIN}/_next/static/chunks/a%2Fb.js`, ORIGIN)).toBe("/_next/static/chunks/a%2Fb.js");
        expect(checkedPath(`${ORIGIN}/_next/static/chunks/bad%E0.js`, ORIGIN)).toBe("/_next/static/chunks/bad%E0.js");
    });

    it("verifies a dynamic route's chunk loaded percent-encoded", () => {
        const routed: IntegrityManifest = { ...manifest, files: { ...manifest.files, "/_next/static/chunks/[id]/p.js": A } };
        const path = checkedPath(`${ORIGIN}/_next/static/chunks/%5Bid%5D/p.js`, ORIGIN);
        expect(path).not.toBeNull();
        expect(judge(STAMP, routed, [{ path: path as string, digest: A }]).kind).toBe("verified");
        expect(servedPath(path as string)).toBe("/_next/static/chunks/%5Bid%5D/p.js");
    });

    it("verifies a page whose files all match", () => {
        expect(judge(STAMP, manifest, [{ path: "/_next/static/chunks/a.js", digest: A }])).toEqual({
            kind: "verified",
            build: STAMP,
            checked: 1
        });
    });

    it("calls a changed file changed", () => {
        const verdict = judge(STAMP, manifest, [{ path: "/_next/static/chunks/a.js", digest: B }]);
        expect(verdict).toEqual({ kind: "changed", build: STAMP, paths: ["/_next/static/chunks/a.js"] });
    });

    it("calls a file added under a prefix the build owns changed", () => {
        const verdict = judge(STAMP, manifest, [
            { path: "/_next/static/chunks/a.js", digest: A },
            { path: "/_next/static/chunks/evil.js", digest: A }
        ]);
        expect(verdict).toMatchObject({ kind: "changed", paths: ["/_next/static/chunks/evil.js"] });
    });

    it("leaves files outside the build's prefixes unchecked", () => {
        const verdict = judge(STAMP, manifest, [
            { path: "/_next/static/chunks/a.js", digest: A },
            { path: "/apps/crm/bundle.js", digest: B }
        ]);
        expect(verdict).toMatchObject({ kind: "verified", checked: 1 });
    });

    it("never verifies without a stamp or a manifest", () => {
        const files = [{ path: "/_next/static/chunks/a.js", digest: A }];
        expect(judge(null, manifest, files)).toEqual({ kind: "unverifiable", reason: "no-stamp" });
        expect(judge(STAMP, null, files)).toEqual({ kind: "unverifiable", reason: "no-manifest" });
        expect(judge("fedcba9876543210", manifest, files)).toEqual({ kind: "unverifiable", reason: "no-manifest" });
        expect(judge(STAMP, manifest, [])).toEqual({ kind: "unverifiable", reason: "nothing-loaded" });
    });
});
