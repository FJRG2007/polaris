/**
 * The version a release cut from `main` gets, and stamping it into the build.
 *
 * The Stream Deck plugin and the Companion module release themselves on every
 * push to `main` that changes what they ship, so nobody bumps a version by hand
 * and no bump commit is ever written. The next version is the newest released
 * tag with its patch moved on, or the version in the package's `package.json`
 * when somebody raised that past every release (which is how a minor or major
 * release is asked for). The answer is stamped into `package.json`, and into the
 * Stream Deck manifest as `<version>.0`, and into a source file's
 * `export const VERSION = "..."` (the Companion module's user-agent), only in
 * the checkout CI builds from.
 *
 *   git tag -l "streamdeck-v*" | node scripts/release-version.mjs next --prefix streamdeck-v --package apps/streamdeck/package.json
 *   node scripts/release-version.mjs stamp --version 0.1.4 --package apps/streamdeck/package.json [--manifest <dir>.sdPlugin/manifest.json] [--constant src/version.ts]
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const RELEASED = /^(\d+)\.(\d+)\.(\d+)$/;

/** The three numbers of a plain `x.y.z`, or null for anything else (a prerelease included). */
export function parseVersion(text) {
    const match = RELEASED.exec(String(text).trim());
    return match ? match.slice(1).map(Number) : null;
}

/** Negative, zero or positive as `a` sorts before, with or after `b`. */
export function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

/** The newest plain version among tags carrying `prefix`, or null when none was released. */
export function latestTagged(tags, prefix) {
    let latest = null;
    for (const tag of tags) {
        const trimmed = tag.trim();
        if (!trimmed.startsWith(prefix)) continue;
        const version = parseVersion(trimmed.slice(prefix.length));
        if (version && (!latest || compareVersions(version, latest) > 0)) latest = version;
    }
    return latest;
}

/**
 * The version the next release gets: the package's own when nothing newer was
 * released, else the newest release with its patch moved on.
 */
export function nextVersion(tags, prefix, packageVersion) {
    const declared = parseVersion(packageVersion);
    if (!declared) throw new Error(`package.json version "${packageVersion}" is not x.y.z`);
    const latest = latestTagged(tags, prefix);
    if (!latest || compareVersions(declared, latest) > 0) return declared.join(".");
    return [latest[0], latest[1], latest[2] + 1].join(".");
}

/** The manifest's four-part `Version` the Stream Deck app reads for `x.y.z`. */
export function manifestVersion(version) {
    if (!parseVersion(version)) throw new Error(`"${version}" is not x.y.z`);
    return `${version}.0`;
}

const CONSTANT = /export const VERSION = "[^"]*";/;

/** `source` with its `export const VERSION = "..."` set to `version`; throws
 *  when there is none, so a renamed constant fails the build instead of
 *  shipping the old number. */
export function stampConstant(source, version) {
    if (!parseVersion(version)) throw new Error(`"${version}" is not x.y.z`);
    if (!CONSTANT.test(source)) throw new Error('no `export const VERSION = "..."` to stamp');
    return source.replace(CONSTANT, `export const VERSION = "${version}";`);
}

function option(args, name) {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
}

function rewrite(path, change) {
    const json = JSON.parse(readFileSync(path, "utf8"));
    change(json);
    writeFileSync(path, `${JSON.stringify(json, null, 4)}\n`);
}

function main(args) {
    const [command] = args;
    const pkg = option(args, "package");
    if (!pkg) throw new Error("--package is required");
    if (command === "next") {
        const prefix = option(args, "prefix");
        if (!prefix) throw new Error("--prefix is required");
        const tags = readFileSync(0, "utf8").split("\n").filter(Boolean);
        const declared = JSON.parse(readFileSync(pkg, "utf8")).version;
        process.stdout.write(`${nextVersion(tags, prefix, declared)}\n`);
        return;
    }
    if (command === "stamp") {
        const version = option(args, "version");
        if (!parseVersion(version ?? "")) throw new Error("--version must be x.y.z");
        rewrite(pkg, (json) => (json.version = version));
        const manifest = option(args, "manifest");
        if (manifest) rewrite(manifest, (json) => (json.Version = manifestVersion(version)));
        const constant = option(args, "constant");
        if (constant)
            writeFileSync(constant, stampConstant(readFileSync(constant, "utf8"), version));
        return;
    }
    throw new Error("usage: release-version.mjs next|stamp ...");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`release-version: ${error.message}\n`);
        process.exitCode = 2;
    }
}
