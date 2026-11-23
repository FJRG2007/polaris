#!/usr/bin/env node
/**
 * The integrity manifest of a web build: the SHA-256 of every file of code the
 * dashboard serves from its build output, keyed by the path a browser asks for.
 *
 * Signed and published by the publish workflow, and read by the browser
 * extension and the desktop app to tell a page that runs the code Polaris built
 * from one that was changed on the way or on the server (docs/integrity.md).
 *
 * Usage: node scripts/integrity-manifest.mjs <apps/web dir> <out file> [build sha]
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";

/** Bumped only on a change a reader of an older one would misread. */
export const SCHEMA = 1;
/** Files a browser runs or applies. Images, fonts and media are not code. */
export const CODE_EXTENSIONS = [".js", ".mjs", ".css", ".wasm"];
/** Where every code file is part of the build, so one missing from the list is
 *  one somebody added. `public/` is not one: it is served from `/`, beside
 *  routes, so only the files it lists are checked there. */
export const COMPLETE_PREFIXES = ["/_next/static/"];
/** The same stamp `/api/version` serves (apps/web/src/lib/build-stamp.ts). */
const STAMP_LENGTH = 16;

export function buildStamp(sha) {
    const value = (sha ?? "").trim();
    return value ? createHash("sha256").update(value).digest("hex").slice(0, STAMP_LENGTH) : null;
}

/** The SRI form of a digest, so the same value can later go into `integrity=`. */
export function digest(bytes) {
    return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

export function isCode(path) {
    return CODE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * The manifest for a list of served files. Pure: `files` is `[path, bytes]`,
 * with the path as a browser requests it. Sorted, so the same build always gives
 * the same bytes and the same signature input.
 */
export function buildManifest(files, sha) {
    const entries = files
        .filter(([path]) => isCode(path))
        .map(([path, bytes]) => [path, digest(bytes)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { schema: SCHEMA, build: buildStamp(sha), prefixes: COMPLETE_PREFIXES, files: Object.fromEntries(entries) };
}

async function walk(root) {
    const found = [];
    const visit = async (dir) => {
        let names;
        try {
            names = await readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        for (const entry of names) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await visit(full);
            else if (entry.isFile()) found.push(full);
        }
    };
    await visit(root);
    return found;
}

/** Every served code file of a built `apps/web`, as `[url path, bytes]`. */
export async function servedFiles(webDir) {
    const roots = [
        [join(webDir, ".next", "static"), "/_next/static/"],
        [join(webDir, "public"), "/"]
    ];
    const files = [];
    for (const [root, prefix] of roots) {
        for (const full of await walk(root)) {
            const path = prefix + relative(root, full).split(sep).join("/");
            if (isCode(path)) files.push([path, await readFile(full)]);
        }
    }
    return files;
}

async function main([webDir, out, sha]) {
    if (!webDir || !out) {
        console.error("usage: integrity-manifest.mjs <apps/web dir> <out file> [build sha]");
        process.exit(2);
    }
    const manifest = buildManifest(await servedFiles(webDir), sha);
    const count = Object.keys(manifest.files).length;
    // A build with no static output is a broken build, not an empty manifest.
    if (!Object.keys(manifest.files).some((path) => path.startsWith(COMPLETE_PREFIXES[0]))) {
        console.error(`no files under ${join(webDir, ".next", "static")} - was the web app built?`);
        process.exit(1);
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`integrity manifest: ${count} files, build ${manifest.build ?? "unstamped"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main(process.argv.slice(2));
