import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { buildManifest, buildStamp, digest, servedFiles } from "../integrity-manifest.mjs";

test("the stamp matches the one /api/version serves", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(buildStamp(sha), createHash("sha256").update(sha).digest("hex").slice(0, 16));
    assert.equal(buildStamp(""), null);
    assert.equal(buildStamp(undefined), null);
});

test("digests are in SRI form", () => {
    assert.equal(digest(Buffer.from("")), "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
});

test("only code is listed, sorted, with the complete prefixes named", () => {
    const manifest = buildManifest(
        [
            ["/_next/static/chunks/b.js", Buffer.from("b")],
            ["/_next/static/media/font.woff2", Buffer.from("font")],
            ["/_next/static/css/a.css", Buffer.from("a")],
            ["/sw.js", Buffer.from("sw")]
        ],
        "abc"
    );
    assert.deepEqual(Object.keys(manifest.files), ["/_next/static/chunks/b.js", "/_next/static/css/a.css", "/sw.js"]);
    assert.deepEqual(manifest.prefixes, ["/_next/static/"]);
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.build, buildStamp("abc"));
});

test("the same build always gives the same bytes", () => {
    const files = [["/_next/static/x.js", Buffer.from("x")], ["/_next/static/a.js", Buffer.from("a")]];
    assert.equal(JSON.stringify(buildManifest(files, "s")), JSON.stringify(buildManifest([...files].reverse(), "s")));
});

test("served files are named by the path a browser asks for", async () => {
    const web = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
        await mkdir(join(web, ".next", "static", "chunks"), { recursive: true });
        await mkdir(join(web, "public", "sub"), { recursive: true });
        await writeFile(join(web, ".next", "static", "chunks", "main.js"), "m");
        await writeFile(join(web, "public", "sub", "worker.js"), "w");
        await writeFile(join(web, "public", "logo.png"), "p");
        const paths = (await servedFiles(web)).map(([path]) => path).sort();
        assert.deepEqual(paths, ["/_next/static/chunks/main.js", "/sub/worker.js"]);
    } finally {
        await rm(web, { recursive: true, force: true });
    }
});

test("a missing public directory is not an error", async () => {
    const web = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
        await mkdir(join(web, ".next", "static"), { recursive: true });
        await writeFile(join(web, ".next", "static", "a.js"), "a");
        assert.equal((await servedFiles(web)).length, 1);
    } finally {
        await rm(web, { recursive: true, force: true });
    }
});
